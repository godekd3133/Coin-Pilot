// 런타임 config 조립 — typed env 객체 → 트레이더/서버가 쓰는 config.
// env 접근의 유일한 진입점: loadEnv()가 검증한 값만 읽고 raw process.env는 건드리지 않는다.
import fs from 'fs';
import { resolveExchange, quoteAssetForExchange } from '../exchange/exchangeFactory.js';
import { resolveTradingLimits } from './tradingLimits.js';
import { resolveOptimizationStoragePaths } from '../runtime/optimizationStorage.js';

export function loadOptimalConfig(env = process.env) {
  const configFile = resolveOptimizationStoragePaths({
    env,
    stateDir: env.COINPILOT_STATE_DIR,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    legacyBase: 'cwd'
  }).optimalConfigFile.absolutePath;

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.parameters) {
        console.log('📂 최적화 파라미터 로드됨 (optimal_config.json)');
        console.log(`   마지막 최적화: ${config.updatedAt || '알 수 없음'}`);
        return config.parameters;
      }
    } catch (error) {
      console.log('⚠️  최적화 파라미터 로드 실패:', error.message);
    }
  }
  return null;
}


export function redactConfigForLog(config) {
  const safeConfig = { ...config };
  delete safeConfig.accessKey;
  delete safeConfig.secretKey;
  return safeConfig;
}

export function createConfig(env) {
  const dryRun = env.DRY_RUN !== false;
  const liveCredentialSetupMode = env.DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE === true;
  const liveManualPrepareOnBoot = env.DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT === true;
  const liveManualRiskProtection = env.DASHBOARD_LIVE_MANUAL_RISK_PROTECTION === true;
  const dashboardStartTraderOnBoot = env.DASHBOARD_START_TRADER_ON_BOOT !== false;
  if (liveCredentialSetupMode && dryRun) {
    throw new Error('DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE requires DRY_RUN=false.');
  }
  if (liveCredentialSetupMode && env.ENABLE_DASHBOARD === false) {
    throw new Error('DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE requires ENABLE_DASHBOARD=true.');
  }
  if (liveCredentialSetupMode && (!liveManualPrepareOnBoot || dashboardStartTraderOnBoot)) {
    throw new Error(
      'DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE requires DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT=true and DASHBOARD_START_TRADER_ON_BOOT=false.'
    );
  }
  if (liveManualPrepareOnBoot && (dryRun || dashboardStartTraderOnBoot)) {
    throw new Error(
      'DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT requires DRY_RUN=false and DASHBOARD_START_TRADER_ON_BOOT=false.'
    );
  }
  if (liveManualRiskProtection && !liveManualPrepareOnBoot) {
    throw new Error(
      'DASHBOARD_LIVE_MANUAL_RISK_PROTECTION requires DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT=true.'
    );
  }
  const strategyMode = env.TRADING_STRATEGY || 'oversold_reaction_scalping';
  const isScalpingMode = strategyMode === 'oversold_reaction_scalping';

  // 최적화된 파라미터 로드 (있으면 사용, 없으면 기본값)
  // 기존 종합점수 전략으로 생성된 파라미터는 스캘핑 반등 계약과 호환되지
  // 않으므로 새 전략에서는 무시한다.
  const optimalParams = isScalpingMode ? null : loadOptimalConfig(env);
  const tradingLimits = resolveTradingLimits({ env, isScalpingMode, optimalParams });

  const exchange = resolveExchange(env);
  const quoteAsset = quoteAssetForExchange(exchange, env);
  const defaultCoins = exchange === 'binance'
    ? [`${quoteAsset}-BTC`, `${quoteAsset}-ETH`, `${quoteAsset}-SOL`]
    : ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'];

  return {
    stateDir: env.COINPILOT_STATE_DIR || null,
    exchange,
    quoteAsset,
    strategyMode,
    isScalpingMode,
    // API 키 — 선택된 거래소의 키를 공통 슬롯에 싣는다.
    accessKey: exchange === 'binance'
      ? (env.BINANCE_API_KEY || '')
      : (env.UPBIT_ACCESS_KEY || ''),
    secretKey: exchange === 'binance'
      ? (env.BINANCE_API_SECRET || '')
      : (env.UPBIT_SECRET_KEY || ''),

    // 다중 코인 설정 (기본값)
    // TARGET_COINS=ALL 이면 해당 거래소의 기준통화 마켓 전체 대상 (main에서 동적 로드)
    targetCoins: env.TARGET_COINS === 'ALL'
      ? [] // 나중에 동적으로 로드
      : env.TARGET_COINS
        ? env.TARGET_COINS.split(',')
        : defaultCoins,
    analyzeAllCoins: env.TARGET_COINS === 'ALL',
    ...tradingLimits,

    investmentAmount: env.INVESTMENT_AMOUNT || (exchange === 'binance' ? 50 : 50000),
    stopLossPercent: isScalpingMode
      ? env.SCALP_STOP_LOSS_PERCENT || 1.2
      : (optimalParams?.stopLossPercent || env.STOP_LOSS_PERCENT || 5),
    takeProfitPercent: isScalpingMode
      ? env.SCALP_TAKE_PROFIT_PERCENT || 1.8
      : (optimalParams?.takeProfitPercent || env.TAKE_PROFIT_PERCENT || 10),

    // 기술적 분석 설정 (최적화 파라미터 우선)
    // RSI
    rsiPeriod: optimalParams?.rsiPeriod || (isScalpingMode ? env.SCALP_RSI_PERIOD : env.RSI_PERIOD) || env.RSI_PERIOD || 14,
    rsiOversold: optimalParams?.rsiOversold || (isScalpingMode ? env.SCALP_RSI_OVERSOLD : env.RSI_OVERSOLD) || env.RSI_OVERSOLD || 30,
    rsiOverbought: optimalParams?.rsiOverbought || (isScalpingMode ? env.SCALP_RSI_OVERBOUGHT : env.RSI_OVERBOUGHT) || env.RSI_OVERBOUGHT || 70,
    // MACD
    macdFast: optimalParams?.macdFast || env.MACD_FAST || 12,
    macdSlow: optimalParams?.macdSlow || env.MACD_SLOW || 26,
    macdSignal: optimalParams?.macdSignal || env.MACD_SIGNAL || 9,
    // 볼린저 밴드
    bbPeriod: optimalParams?.bbPeriod || env.BB_PERIOD || 20,
    bbStdDev: optimalParams?.bbStdDev || env.BB_STD_DEV || 2.0,
    // EMA
    emaShort: optimalParams?.emaShort || env.EMA_SHORT || 10,
    emaMid: optimalParams?.emaMid || env.EMA_MID || 30,
    emaLong: optimalParams?.emaLong || env.EMA_LONG || 60,
    // 트레일링 스탑: legacy strategy keeps its old setting; scalping uses
    // the opt-in protective-exit setting below.
    trailingStopPercent: isScalpingMode
      ? (env.SCALP_TRAILING_STOP_PERCENT ?? 0)
      : (optimalParams?.trailingStopPercent || env.TRAILING_STOP_PERCENT || 3),
    // 거래량
    volumeMultiplier: optimalParams?.volumeMultiplier || env.VOLUME_MULTIPLIER || 1.5,
    volumePeriod: optimalParams?.volumePeriod || env.VOLUME_PERIOD || 20,

    // 뉴스 모니터링 설정
    newsCheckInterval: env.NEWS_CHECK_INTERVAL || 300000,
    newsSentimentThreshold: env.NEWS_SENTIMENT_THRESHOLD || 0.5,

    // 매매 임계값 (최적화 파라미터 우선, 기본값 55로 적극적 매수)
    buyThreshold: optimalParams?.buyThreshold || env.BUY_THRESHOLD || 55,
    sellThreshold: optimalParams?.sellThreshold || env.SELL_THRESHOLD || 55,

    // 매수 전용 모드 (환경변수 BUY_ONLY=true로 활성화)
    buyOnly: env.BUY_ONLY === true,

    // 기존 포지션에 추가 매수 허용 (기본: true, STRONG 이상 신호에서 추가 매수)
    allowAveraging: isScalpingMode
      ? env.SCALP_ALLOW_AVERAGING === true
      : env.ALLOW_AVERAGING !== false,

    // 가중치 설정 (최적화 파라미터 우선)
    technicalWeight: optimalParams?.technicalWeight || env.TECHNICAL_WEIGHT || 0.6,
    newsWeight: optimalParams?.technicalWeight ? (1 - optimalParams.technicalWeight) : (env.NEWS_WEIGHT || 0.4),

    // 과매도 반응 스캘핑 설정
    candleUnit: isScalpingMode
      ? env.SCALP_CANDLE_UNIT || 1
      : env.CANDLE_UNIT || 5,
    candleCount: isScalpingMode
      ? env.SCALP_CANDLE_COUNT || 120
      : env.CANDLE_COUNT || 200,
    // 0 uses the candle-unit-aware safety default (90s for 1-minute candles).
    maxCandleAgeSeconds: isScalpingMode
      ? (env.SCALP_MAX_CANDLE_AGE_SECONDS ?? 0)
      : 0,
    oversoldLookback: env.SCALP_OVERSOLD_LOOKBACK || 1,
    minReboundPercent: env.SCALP_MIN_REBOUND_PERCENT || 0.15,
    minRsiRecovery: env.SCALP_MIN_RSI_RECOVERY || 2,
    minVolumeRatio: (env.SCALP_MIN_VOLUME_RATIO ?? 1.0),
    volumeLookback: env.SCALP_VOLUME_LOOKBACK || 20,
    minCloseStrength: (env.SCALP_MIN_CLOSE_STRENGTH ?? 0.65),
    trendPeriod: env.SCALP_TREND_PERIOD || 30,
    trendSlopeLookback: env.SCALP_TREND_SLOPE_LOOKBACK || 3,
    minTrendSlopePercent: (env.SCALP_MIN_TREND_SLOPE_PERCENT ?? -0.2),
    requirePreviousHighBreak: env.SCALP_REQUIRE_PREVIOUS_HIGH_BREAK !== false,
    maxSignalRangePercent: (env.SCALP_MAX_SIGNAL_RANGE_PERCENT ?? 0),
    minSignalRangePercent: (env.SCALP_MIN_SIGNAL_RANGE_PERCENT ?? 0),
    // Optional research-only exhaustion guard; zero preserves the existing
    // lower-bound-only rebound contract.
    maxReboundPercent: (env.SCALP_MAX_REBOUND_PERCENT ?? 0),
    marketRegimeEnabled: env.SCALP_MARKET_REGIME_ENABLED === true,
    marketRegimeLookback: env.SCALP_MARKET_REGIME_LOOKBACK || 5,
    marketRegimeMinBreadth: (env.SCALP_MARKET_REGIME_MIN_BREADTH ?? 0.5),
    marketRegimeMinReturnPercent: (env.SCALP_MARKET_REGIME_MIN_RETURN_PERCENT ?? -0.2),
    requireReboundBelowOverbought: env.SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT === true,
    signalProfile: env.SCALP_SIGNAL_PROFILE || 'rsi_rebound',
    entryDelayMinMs: env.SCALP_ENTRY_DELAY_MIN_MS || 1000,
    entryDelayMaxMs: env.SCALP_ENTRY_DELAY_MAX_MS || 5000,
    maxEntryRetracePercent: env.SCALP_MAX_ENTRY_RETRACE_PERCENT || 0.25,
    maxEntryChasePercent: env.SCALP_MAX_ENTRY_CHASE_PERCENT || 0.35,
    // Optional protective exits. Zero trigger keeps the fixed stop/take
    // contract; enable only after an independent holdout study.
    breakEvenTriggerPercent: (env.SCALP_BREAK_EVEN_TRIGGER_PERCENT ?? 0),
    breakEvenOffsetPercent: (env.SCALP_BREAK_EVEN_OFFSET_PERCENT ?? 0.05),
    trailingActivationPercent: (env.SCALP_TRAILING_ACTIVATION_PERCENT ?? 0),
    maxHoldMinutes: env.SCALP_MAX_HOLD_MINUTES || 30,
    maxLosingHoldMinutes: (env.SCALP_MAX_LOSING_HOLD_MINUTES ?? 0),
    winnerExtendMinutes: (env.SCALP_WINNER_EXTEND_MINUTES ?? 0),
    winnerExtendMinProfitPercent: (env.SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT ?? 0),
    winnerShadowExtendMinutes: (env.SCALP_WINNER_SHADOW_EXTEND_MINUTES ?? 0),
    winnerShadowExtendMinProfitPercent: (env.SCALP_WINNER_SHADOW_EXTEND_MIN_PROFIT_PERCENT ?? 0),
    winnerShadowMaxReboundPercent: (env.SCALP_WINNER_SHADOW_MAX_REBOUND_PERCENT ?? 0),
    paperDiagnosticShadowsEnabled: env.SCALP_PAPER_DIAGNOSTIC_SHADOWS_ENABLED !== false,
    maxEntriesPerSignalWindow: env.SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW || 0,
    positionRiskCheckIntervalMs: env.SCALP_RISK_CHECK_INTERVAL_MS || 1000,
    maxRiskDataGapSeconds: (env.SCALP_MAX_RISK_DATA_GAP_SECONDS ?? 30),
    maxAnalysisDataGapSeconds: (env.SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS ?? 60),
    cooldownAfterLossMinutes: env.SCALP_COOLDOWN_AFTER_LOSS_MINUTES || 15,
    maxConsecutiveLosses: env.SCALP_MAX_CONSECUTIVE_LOSSES || 3,
    // 0 disables the process-wide sliding-window circuit breaker.
    lossCircuitBreakerCount: env.SCALP_LOSS_CIRCUIT_BREAKER_COUNT || 0,
    lossCircuitBreakerWindowMinutes: (env.SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES ?? 30),
    lossCircuitBreakerCooldownMinutes: (env.SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES ?? 60),
    paperValidationMinDays: env.SCALP_PAPER_MIN_DAYS || 7,
    paperValidationMinTrades: env.SCALP_PAPER_MIN_TRADES || 20,
    paperValidationMinReturnPercent: (env.SCALP_PAPER_MIN_RETURN_PERCENT ?? 0.2),
    paperValidationMaxDrawdownPercent: (env.SCALP_PAPER_MAX_DRAWDOWN_PERCENT ?? 15),
    paperValidationMaxHeartbeatGapMinutes: (env.SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES ?? 15),
    // Validation CLI, API projection, and live gate must share the same
    // explicit report identity. The default preserves the legacy root path.
    scalpingValidationOutputFile: env.SCALP_VALIDATION_OUTPUT_FILE || 'scalping_validation.json',
    maxScalpMarkets: env.SCALP_MAX_MARKETS || 20,
    upbitRequestTimeoutMs: env.UPBIT_REQUEST_TIMEOUT_MS || 10000,
    requireValidationPassForLive: env.SCALP_REQUIRE_VALIDATION_PASS !== false,
    useNews: !isScalpingMode,

    // AI 자문은 ChatGPT/Claude API key가 아니라 로컬 구독 CLI 세션을
    // 사용한다. 자문 결과는 기록/표시만 하고 주문 실행에는 연결하지 않는다.
    aiAdvisorEnabled: env.AI_ADVISOR_ENABLED !== false,
    aiLocalBriefEnabled: env.AI_LOCAL_BRIEF_ENABLED !== false,
    aiAdvisorTimeoutMs: env.AI_ADVISOR_TIMEOUT_MS || 60000,
    aiMonitoringFile: env.AI_MONITORING_FILE || '',
    aiCodexBin: env.AI_CODEX_BIN || 'codex',
    aiCodexIgnoreUserConfig: env.AI_CODEX_IGNORE_USER_CONFIG !== false,
    aiClaudeBin: env.AI_CLAUDE_BIN || 'claude',
    aiGptModel: env.AI_GPT_MODEL || '',
    aiClaudeModel: env.AI_CLAUDE_MODEL || '',
    aiEvaluationMinutes: (env.AI_EVALUATION_MINUTES ?? 5),
    aiEvaluationNeutralBandPercent: (env.AI_EVALUATION_NEUTRAL_BAND_PERCENT ?? 0.3),
    aiEvaluationMinSamples: env.AI_EVALUATION_MIN_SAMPLES || 20,

    // 체크 간격 (드라이 모드일 때 더 짧게)
    checkInterval: dryRun
      ? env.CHECK_INTERVAL_DRY || (isScalpingMode ? 5000 : 30000)
      : env.CHECK_INTERVAL || (isScalpingMode ? 5000 : 60000),

    // 백테스팅 간격 (드라이 모드에서만)
    backtestInterval: env.BACKTEST_INTERVAL || 3600000, // 1시간

    // 드라이 모드 시드 자금
    dryRunSeedMoney: env.DRY_RUN_SEED_MONEY || 10000000, // 1000만원

    // 운영 모드
    dryRun,
    liveCredentialSetupMode,
    liveManualPrepareOnBoot,
    liveManualRiskProtection,
    dashboardStartTraderOnBoot,
    // 안전 중지 후 자동 재개 감시 (fail-closed 경계는 유지, 복구만 자동화)
    autoRecoveryEnabled: env.AUTO_RECOVERY_ENABLED !== false,
    autoRecoveryProbeIntervalMs: env.AUTO_RECOVERY_PROBE_INTERVAL_MS || 15000,
    autoRecoveryMinDownMs: env.AUTO_RECOVERY_MIN_DOWN_MS ?? 30000,
    autoRecoveryHealthyProbes: env.AUTO_RECOVERY_HEALTHY_PROBES || 2,
    autoRecoveryStateFile: env.AUTO_RECOVERY_STATE_FILE || null,
    // LIVE fixed-config 검증 리포트 자동 갱신 (24h 신선도 게이트용 증거 보강)
    liveValidationRefreshEnabled: env.LIVE_VALIDATION_REFRESH_ENABLED !== false,
    liveValidationRefreshIntervalMs: env.LIVE_VALIDATION_REFRESH_INTERVAL_MS || 43200000,
    liveValidationRefreshMinGapMs: env.LIVE_VALIDATION_REFRESH_MIN_GAP_MS || 1800000,
    liveValidationRefreshTimeoutMs: env.LIVE_VALIDATION_REFRESH_TIMEOUT_MS || 900000,
    logLevel: env.LOG_LEVEL || 'info',
    enableDashboard: env.ENABLE_DASHBOARD !== false,
    dashboardPort: env.DASHBOARD_PORT || 3000
  };
}

export function printBanner() {
  console.log('\n' + '='.repeat(80));
  console.log('🤖 과매도 반응 스캘핑 자동투자 시스템');
  console.log('='.repeat(80));
  console.log('');
  console.log('주요 기능:');
  console.log('  1. 다중 코인 동시 거래');
  console.log('  2. 완료 1분봉 기준 RSI 과매도 반등 확인');
  console.log('  3. 반등 확인 후 1~5초 지연 재검증 진입');
  console.log('  4. 스캘핑 손절/익절/최대 보유시간 관리');
  console.log('  5. 모의투자 기본 및 웹 대시보드 모니터링');
  console.log('');
  console.log('='.repeat(80));
  console.log('');
}

export function printConfig(config) {
  console.log('⚙️  설정 정보:');
  console.log(`  전략: ${config.strategyMode}`);
  console.log(`  모드: ${config.dryRun ? '🧪 모의투자' : '💰 실전투자'}`);

  console.log(`  분석 대상: ${config.targetCoins.length}개 코인`);

  console.log(`  포지션 제한: ${config.maxPositions}개`);
  console.log(`  포트폴리오 할당: ${(config.portfolioAllocation * 100).toFixed(0)}%`);
  console.log(`  투자 비율: ${(config.investmentRatio * 100).toFixed(1)}%`);
  console.log(`  손절률: ${config.stopLossPercent}%`);
  console.log(`  익절률: ${config.takeProfitPercent}%`);
  console.log(`  체크 간격: ${config.checkInterval / 1000}초`);
  if (config.isScalpingMode) {
    console.log(`  반등 캔들: ${config.candleUnit}분봉 / ${config.candleCount}개`);
    console.log(`  진입 지연: ${config.entryDelayMinMs}~${config.entryDelayMaxMs}ms`);
    console.log(`  스캔 마켓: 최대 ${config.maxScalpMarkets}개`);
    console.log(`  동일 신호창 동시 진입 상한: ${config.maxEntriesPerSignalWindow > 0 ? `${config.maxEntriesPerSignalWindow}개` : '비활성화'}`);
    console.log(`  전역 손실 회로차단기: ${config.lossCircuitBreakerCount > 0 ? `${config.lossCircuitBreakerCount}회/${config.lossCircuitBreakerWindowMinutes}분 → ${config.lossCircuitBreakerCooldownMinutes}분 차단` : '비활성화'}`);
    console.log(`  뉴스 분석: 비활성화 (초단기 반응 전용)`);
  } else {
    console.log(`  뉴스 체크 간격: ${config.newsCheckInterval / 1000}초`);
  }

  if (config.dryRun) {
    console.log(`  시드 머니: ${config.dryRunSeedMoney.toLocaleString()} 원`);
    console.log(`  백테스팅 간격: ${config.backtestInterval / 60000}분`);
  }

  console.log('');

  if (config.dryRun) {
    console.log('⚠️  모의투자 모드입니다. 실제 거래는 발생하지 않습니다.');
    console.log('   - 시드 머니로 가상 거래를 시뮬레이션합니다.');
    console.log('   - 주기적으로 백테스팅을 실행하여 전략을 검증합니다.');
    console.log('   - 더 짧은 간격으로 체크 및 최적화가 진행됩니다.');
    console.log('   실전투자를 원하시면 .env 파일에서 DRY_RUN=false로 설정하세요.');
    console.log('');
  } else {
    console.log('🚨 실전투자 모드입니다! 실제 거래가 발생합니다.');
    console.log('   충분한 테스트 후 사용하세요.');
    console.log('');
  }
}
