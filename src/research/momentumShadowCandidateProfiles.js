import { resolveMomentumShadowCandidateConfig } from './momentumShadowCandidateConfig.js';

export const MOMENTUM_SHADOW_CANDIDATE_PROFILES = Object.freeze([
  'baseline',
  'quote_cross',
  'loss_cap',
  'loss_cap_no_doge'
]);

export const MOMENTUM_SHADOW_HISTORICAL_EVIDENCE = Object.freeze({
  loss_cap_no_doge: Object.freeze({
    researchOnly: true,
    promoted: false,
    status: 'SHADOW_CANDIDATE',
    sourceReports: Object.freeze([
      'coinpilot-daily-momentum-market-filter-doge-loss-cap-400-noDoge-20260917.json',
      'coinpilot-daily-momentum-market-filter-doge-loss-cap-800-noDoge-20260917.json'
    ]),
    windows: Object.freeze([
      Object.freeze({
        days: 400,
        returnPercent: 4.656583971459316,
        tradeCount: 88,
        profitFactor: 1.8427178859196738,
        maxDrawdownPercent: 1.3213692150291592,
        worstSegmentReturnPercent: -0.5323776404582481,
        blockers: Object.freeze([])
      }),
      Object.freeze({
        days: 800,
        returnPercent: 9.298119749242861,
        tradeCount: 218,
        profitFactor: 1.6608090660174784,
        maxDrawdownPercent: 1.8196664523332247,
        worstSegmentReturnPercent: 0.32106753873504257,
        blockers: Object.freeze([])
      })
    ]),
    rollingWindows: Object.freeze([
      Object.freeze({ days: 120, status: 'INSUFFICIENT_SAMPLE', returnPercent: 3.4739588369230967, tradeCount: 26, profitFactor: 3.2082716782150893, maxDrawdownPercent: 0.7012884707176774, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 180, status: 'POSITIVE_OBSERVATION', returnPercent: 3.839034056116053, tradeCount: 42, profitFactor: 2.228790765298956, maxDrawdownPercent: 0.7554419639620791, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 240, status: 'POSITIVE_OBSERVATION', returnPercent: 4.090463842895731, tradeCount: 53, profitFactor: 2.1234102123444765, maxDrawdownPercent: 1.3213692150291705, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 300, status: 'POSITIVE_OBSERVATION', returnPercent: 4.293556038303148, tradeCount: 66, profitFactor: 1.92123001791294, maxDrawdownPercent: 1.4607882252649562, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 365, status: 'POSITIVE_OBSERVATION', returnPercent: 4.145599305349457, tradeCount: 77, profitFactor: 1.7770799726345503, maxDrawdownPercent: 1.4607882252649667, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 400, status: 'POSITIVE_OBSERVATION', returnPercent: 4.511092869208033, tradeCount: 88, profitFactor: 1.8072713567433514, maxDrawdownPercent: 1.4607882252649296, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 500, status: 'POSITIVE_OBSERVATION', returnPercent: 6.512859123470127, tradeCount: 118, profitFactor: 1.8562936462736555, maxDrawdownPercent: 1.4607882252649456, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 600, status: 'POSITIVE_OBSERVATION', returnPercent: 7.729874224665889, tradeCount: 141, profitFactor: 1.8309811563540357, maxDrawdownPercent: 1.8098491018488885, unknownBoundaryCount: 0 }),
      Object.freeze({ days: 800, status: 'POSITIVE_OBSERVATION', returnPercent: 8.649380558728703, tradeCount: 213, profitFactor: 1.6166152002494811, maxDrawdownPercent: 1.809849101848905, unknownBoundaryCount: 0 })
    ]),
    rollingSourceReport: 'coinpilot-daily-momentum-rolling-loss-cap-no-doge-20260918.json',
    costStress: Object.freeze([
      Object.freeze({ costPercent: 0.3, status: 'SHADOW_CANDIDATE', returnPercent: 8.649380558728703, profitFactor: 1.6166152002494811, maxDrawdownPercent: 1.809849101848905, worstSegmentReturnPercent: 0.32106753873504257 }),
      Object.freeze({ costPercent: 0.4, status: 'SHADOW_CANDIDATE', returnPercent: 9.052, profitFactor: 1.62, maxDrawdownPercent: 1.87, worstSegmentReturnPercent: -0.054 }),
      Object.freeze({ costPercent: 0.5, status: 'SHADOW_CANDIDATE', returnPercent: 8.07, profitFactor: 1.54, maxDrawdownPercent: 1.91, worstSegmentReturnPercent: -0.15 }),
      Object.freeze({ costPercent: 1.2, status: 'SHADOW_CANDIDATE', returnPercent: 1.345, profitFactor: 1.07, maxDrawdownPercent: 2.64, worstSegmentReturnPercent: -0.813 }),
      Object.freeze({ costPercent: 1.5, status: 'HOLD', returnPercent: -1.593, profitFactor: null, maxDrawdownPercent: 4.38, worstSegmentReturnPercent: -1.289 }),
      Object.freeze({ costPercent: 1.8, status: 'HOLD', returnPercent: -4.274, profitFactor: null, maxDrawdownPercent: 6.49, worstSegmentReturnPercent: -1.571 }),
      Object.freeze({ costPercent: 2.0, status: 'HOLD', returnPercent: -6.127, profitFactor: null, maxDrawdownPercent: 8.22, worstSegmentReturnPercent: -1.841 })
    ]),
    note: '완료 일봉 historical study 요약이며 실제 fill·wallet settlement·live profitability를 증명하지 않습니다.'
  })
});

export function getMomentumShadowHistoricalEvidence(profile) {
  return MOMENTUM_SHADOW_HISTORICAL_EVIDENCE[String(profile || '')] || null;
}

const QUOTE_CROSS_PRESET = Object.freeze({
  MOMO_SHADOW_MODE: 'fixed',
  MOMO_SHADOW_MAX_HOLD_HOURS: '48',
  MOMO_SHADOW_BENCHMARK_MARKET: 'KRW-BTC',
  MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: '1',
  MOMO_SHADOW_TREND_MIN_PERCENT: '2',
  MOMO_SHADOW_BREADTH_MIN: '3',
  MOMO_SHADOW_MIN_UP_BARS: '2',
  MOMO_SHADOW_POSITION_FRACTION: '0.125',
  MOMO_SHADOW_MAX_POSITIONS: '2',
  MOMO_SHADOW_COST_PERCENT: '0.3',
  MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: 'true',
  MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: '3',
  MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: '15',
  MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '14',
  MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1',
  MOMO_SHADOW_ENTRY_EXECUTION: 'next_open',
  MOMO_SHADOW_EXECUTION_MODEL: 'quote_cross',
  MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '0.2',
  MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '36',
  MOMO_SHADOW_MAX_SPREAD_PERCENT: '0.5',
  MOMO_SHADOW_REQUEST_INTERVAL_MS: '500',
  MOMO_SHADOW_STOP_LOSS_PERCENT: '0',
  MOMO_SHADOW_TAKE_PROFIT_PERCENT: '0',
  MOMO_SHADOW_POLL_MS: '900000'
});

const LOSS_CAP_PRESET = Object.freeze({
  MOMO_SHADOW_MODE: 'fixed',
  MOMO_SHADOW_MAX_HOLD_HOURS: '48',
  MOMO_SHADOW_BENCHMARK_MARKET: 'KRW-BTC',
  MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: '1',
  MOMO_SHADOW_TREND_MIN_PERCENT: '2',
  MOMO_SHADOW_BREADTH_MIN: '3',
  MOMO_SHADOW_MIN_UP_BARS: '2',
  MOMO_SHADOW_POSITION_FRACTION: '0.125',
  MOMO_SHADOW_MAX_POSITIONS: '2',
  MOMO_SHADOW_COST_PERCENT: '0.3',
  MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: 'true',
  MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: '3',
  MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: '15',
  MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '14',
  MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1',
  MOMO_SHADOW_ENTRY_EXECUTION: 'next_open',
  MOMO_SHADOW_EXECUTION_MODEL: 'candle_close',
  MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '0.2',
  MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '36',
  MOMO_SHADOW_MAX_SPREAD_PERCENT: '0',
  MOMO_SHADOW_REQUEST_INTERVAL_MS: '500',
  // This is a completed-daily-close research hypothesis, not an intraday fill
  // or promotion claim. The 4% value is the lower-drawdown choice from the
  // refreshed 400/800-day cost-0.3% sweep; it remains forward research only.
  MOMO_SHADOW_STOP_LOSS_PERCENT: '4',
  MOMO_SHADOW_TAKE_PROFIT_PERCENT: '0',
  MOMO_SHADOW_POLL_MS: '900000'
});

// The 400/800-day daily-momentum market-filter study kept the same loss-cap
// contract but excluded DOGE. Both windows were SHADOW_CANDIDATE with no
// historical eligibility blockers. This remains a research-only sealed
// profile; it must not be treated as alpha or live approval.
const LOSS_CAP_NO_DOGE_PRESET = Object.freeze({
  ...LOSS_CAP_PRESET,
  MOMO_SHADOW_MARKETS: 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL,KRW-ADA,KRW-DOT,KRW-LINK,KRW-ATOM,KRW-NEAR,KRW-ETC,KRW-SUI'
});

function normalizeProfile(value) {
  const profile = String(value || '').trim() || 'baseline';
  if (!MOMENTUM_SHADOW_CANDIDATE_PROFILES.includes(profile)) {
    throw new Error(`unknown MOMO_SHADOW_CANDIDATE_PROFILE=${profile}`);
  }
  return profile;
}

/**
 * Resolve the sealed candidate identity used by both read-only preflight and
 * the detached launcher. Keeping this contract in one module prevents a
 * profile from being checked as one book and started as another book.
 */
export function resolveMomentumShadowCandidateProfile({
  profile,
  env = process.env
} = {}) {
  const candidateProfile = normalizeProfile(
    profile === undefined ? env.MOMO_SHADOW_CANDIDATE_PROFILE : profile
  );
  const fixedHoldQuoteCrossDir = env.MOMO_SHADOW_FIXED_HOLD_QUOTE_CROSS_DIR ||
    '.paper-momentum-shadow-fixed-hold-2d-quote-cross-v1';
  const fixedHoldLossCapDir = env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR ||
    '.paper-momentum-shadow-fixed-hold-2d-loss-cap-v1';
  const fixedHoldLossCapNoDogeDir = env.MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_NO_DOGE_DIR ||
    '.paper-momentum-shadow-fixed-hold-2d-loss-cap-no-doge-v1';
  const targetDir = env.MOMO_SHADOW_CANDIDATE_DIR || (
    candidateProfile === 'quote_cross'
      ? fixedHoldQuoteCrossDir
      : candidateProfile === 'loss_cap'
        ? fixedHoldLossCapDir
        : candidateProfile === 'loss_cap_no_doge'
          ? fixedHoldLossCapNoDogeDir
        : '.paper-momentum-shadow-btc-gate-v2'
  );
  const preset = candidateProfile === 'quote_cross'
    ? QUOTE_CROSS_PRESET
    : candidateProfile === 'loss_cap'
      ? LOSS_CAP_PRESET
      : candidateProfile === 'loss_cap_no_doge'
        ? LOSS_CAP_NO_DOGE_PRESET
      : null;
  const candidateConfig = resolveMomentumShadowCandidateConfig(
    preset ? { ...env, ...preset } : env
  );

  return {
    candidateProfile,
    targetDir,
    candidateConfig,
    requireQuoteQuality: candidateConfig.maxSpreadPercent > 0 ||
      candidateConfig.executionModel === 'quote_cross',
    fixedHoldQuoteCrossDir,
    fixedHoldLossCapDir,
    fixedHoldLossCapNoDogeDir
  };
}
