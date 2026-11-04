// 투자 기간별(단기/스윙/중기/장기) 포트폴리오 슬리브 정의.
// 같은 차트 분석 엔진을 기간에 맞는 봉 주기·지표 기간·청산 규칙으로 사용한다.
// 1분봉 과매도 반등 스캘핑(초단기)은 기존 MultiCoinTrader/StockTrader가 담당한다.
//
// mode
//  - signal : 매 봉마다 점수가 진입 기준을 넘으면 진입, ATR 트레일링/점수 악화/보유기간으로 청산
//  - rank   : rebalanceBars마다 전 종목 점수를 순위화해 상위 N개를 보유(모멘텀 로테이션)
//
// 기본 파라미터는 `npm run research:horizons` 워크포워드 연구(업비트 실데이터)로 보정한다.
// 연구 결과 파일(HORIZON_PARAMS_FILE)이 있으면 그 값이 우선한다.

export const HORIZON_KEYS = Object.freeze(['short', 'swing', 'mid', 'long']);

export const HORIZON_LABELS = Object.freeze({
  short: '단기 (1~3일)',
  swing: '스윙 (~1주)',
  mid: '중기 (1~3개월)',
  long: '장기 (3개월+)'
});

const BASE = {
  short: {
    key: 'short',
    // 봉 ATR%가 이보다 큰 종목(상장 직후 급등락 등)은 진입 후보에서 제외
    maxAtrPercent: 6,
    mode: 'signal',
    interval: { coin: '60m', stock: '1d' },
    periods: { emaFast: 8, emaSlow: 21, emaLong: 55, rocShort: 3, rocLong: 12, breakoutLookback: 12, bbPeriod: 20, volumeLookback: 20 },
    entryScore: 40,
    exitScore: -5,
    atrStopMultiple: 2,
    maxHoldBars: { coin: 72, stock: 3 },
    maxPositions: 3,
    weight: 0.15,
    regimeFilter: true,
    regimeExit: false,
    rebalanceBars: 1,
    riskPerTradePercent: 1
  },
  swing: {
    key: 'swing',
    // 봉 ATR%가 이보다 큰 종목(상장 직후 급등락 등)은 진입 후보에서 제외
    maxAtrPercent: 10,
    mode: 'signal',
    interval: { coin: '240m', stock: '1d' },
    periods: { emaFast: 10, emaSlow: 30, emaLong: 90, rocShort: 6, rocLong: 30, breakoutLookback: 20 },
    entryScore: 35,
    exitScore: -10,
    atrStopMultiple: 2.5,
    maxHoldBars: { coin: 42, stock: 7 },
    maxPositions: 3,
    weight: 0.25,
    regimeFilter: true,
    regimeExit: false,
    rebalanceBars: 1,
    riskPerTradePercent: 1
  },
  mid: {
    key: 'mid',
    // 봉 ATR%가 이보다 큰 종목(상장 직후 급등락 등)은 진입 후보에서 제외
    maxAtrPercent: 15,
    mode: 'rank',
    interval: { coin: '1d', stock: '1d' },
    periods: { emaFast: 20, emaSlow: 50, emaLong: 100, rocShort: 20, rocLong: 60, breakoutLookback: 55, bbPeriod: 20, volumeLookback: 20 },
    entryScore: 25,
    exitScore: 0,
    atrStopMultiple: 3,
    maxHoldBars: { coin: 90, stock: 90 },
    maxPositions: 4,
    weight: 0.3,
    regimeFilter: true,
    regimeExit: true,
    rebalanceBars: 5,
    riskPerTradePercent: 1
  },
  long: {
    key: 'long',
    // 봉 ATR%가 이보다 큰 종목(상장 직후 급등락 등)은 진입 후보에서 제외
    maxAtrPercent: 35,
    mode: 'rank',
    interval: { coin: '1w', stock: '1w' },
    periods: { emaFast: 10, emaSlow: 20, emaLong: 40, rocShort: 4, rocLong: 26, breakoutLookback: 26, bbPeriod: 20, volumeLookback: 12, atrPeriod: 10, rsiPeriod: 14 },
    entryScore: 20,
    exitScore: -5,
    atrStopMultiple: 3.5,
    maxHoldBars: { coin: 520, stock: 520 },
    maxPositions: 4,
    weight: 0.3,
    regimeFilter: true,
    regimeExit: true,
    rebalanceBars: 4,
    riskPerTradePercent: 1
  }
};

export const ASSET_COSTS = Object.freeze({
  coin: { buyCostRate: 0.0005 + 0.001, sellCostRate: 0.0005 + 0.001 },
  stock: { buyCostRate: 0.00015 + 0.001, sellCostRate: 0.00015 + 0.002 + 0.001 }
});

export const INTERVAL_MS = Object.freeze({
  '60m': 60 * 60 * 1000,
  '240m': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000
});

/**
 * @param {'coin'|'stock'} assetClass
 * @param {object} overrides { [horizonKey]: Partial<profile> } (연구 결과/환경설정)
 */
export function resolveHorizonProfiles(assetClass, overrides = {}) {
  const profiles = {};
  for (const key of HORIZON_KEYS) {
    const base = BASE[key];
    const override = overrides?.[key] || {};
    profiles[key] = {
      ...base,
      ...override,
      periods: { ...base.periods, ...(override.periods || {}) },
      interval: base.interval[assetClass],
      maxHoldBars: typeof override.maxHoldBars === 'number' ? override.maxHoldBars : base.maxHoldBars[assetClass],
      label: HORIZON_LABELS[key]
    };
  }
  return profiles;
}

/** 슬리브 비중 합을 1로 정규화(비활성 슬리브 제외). */
export function normalizeWeights(profiles, enabledKeys = HORIZON_KEYS) {
  const active = enabledKeys.filter(key => profiles[key] && profiles[key].weight > 0);
  const total = active.reduce((sum, key) => sum + profiles[key].weight, 0);
  const weights = {};
  for (const key of HORIZON_KEYS) weights[key] = active.includes(key) && total > 0 ? profiles[key].weight / total : 0;
  return weights;
}
