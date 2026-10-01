import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateClosedCandleRebound } from '../src/analysis/technicalIndicators.js';
import {
  calculateRsiSeries,
  computeReboundPoint,
  decideReboundSignal
} from '../src/analysis/reboundSignal.js';
import { createScalpingFeatureCache } from '../src/backtest/scalpingBacktest.js';

// 라이브/백테스트 공용 설정 — 기본값이 의도적으로 다르므로(예: minVolumeRatio
// 0.8 vs 1.0) 비교는 명시 설정으로만 수행한다.
const SHARED_CONFIG = {
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  oversoldLookback: 3,
  minReboundPercent: 0.15,
  minRsiRecovery: 2,
  minVolumeRatio: 0.8,
  volumeLookback: 20,
  minCloseStrength: 0.55,
  trendPeriod: 30,
  trendSlopeLookback: 3,
  minTrendSlopePercent: -0.5,
  requirePreviousHighBreak: false,
  maxSignalRangePercent: 0,
  minSignalRangePercent: 0,
  maxReboundPercent: 0,
  requireReboundBelowOverbought: false,
  signalProfile: 'rsi_rebound',
  bbPeriod: 20,
  bbStdDev: 2,
  emaPeriod: 20
};

function makeCandle(index, close, open = close, volume = 100 + index) {
  return {
    trade_price: close,
    opening_price: open,
    high_price: Math.max(close, open) * 1.002,
    low_price: Math.min(close, open) * 0.998,
    candle_acc_trade_volume: volume,
    candle_date_time_utc: `2026-09-09T00:${String(index).padStart(2, '0')}:00`
  };
}

// 시간순(오래된→최신) 캔들 창: 긴 하락 후 과매도 → 양봉 반등 패턴.
function chronologicalWindow() {
  const candles = [];
  for (let index = 0; index < 60; index += 1) {
    candles.push(makeCandle(index, 120 - index * 0.4, (120 - index * 0.4) + 0.3));
  }
  // 직전 봉은 과매도 저점, 최신 완료 봉은 양봉 반등
  candles.push(makeCandle(60, 95.5, 96.2, 400));
  candles.push(makeCandle(61, 96.4, 95.4, 420));
  return candles;
}

const DECISION_FIELDS = [
  'reboundConfirmed', 'previousWasOversold', 'currentWasOversold', 'bullishCandle',
  'priceChangePercent', 'reboundPriceChangePercent', 'rsi', 'previousRsi',
  'rsiRecovery', 'volumeRatio', 'volumeConfirmed', 'signalRangePercent',
  'volatilityConfirmed', 'signalRangeFloorConfirmed', 'reboundCeilingConfirmed',
  'closeStrength', 'closeStrengthConfirmed', 'trendSlopePercent', 'trendConfirmed',
  'previousHighBreak', 'previousHighBreakConfirmed', 'profileConfirmed',
  'momentumRsiConfirmed', 'reboundOverboughtConfirmed', 'momentumBreakoutConfirmed',
  'bollingerReclaim', 'emaTrendConfirmed', 'emaSlopePercent',
  'oversoldCandleAge', 'oversoldRsi', 'rejectionReasons', 'signalKey', 'candleTime'
];

// 캐시 producer는 prefix-sum, 표준 producer는 slice 합계를 쓰므로 누적 순서가
// 달라 float 미세 오차(1e-13 상대)가 난다 — 수치 필드는 epsilon 비교로,
// 계약 필드(불리언/문자열/배열)는 정확 비교로 드리프트를 감시한다.
const FP_TOLERANCE = 1e-9;

function assertParity(actual, expected, context) {
  for (const field of Object.keys(expected)) {
    const a = actual[field];
    const e = expected[field];
    const isPlainObject = value =>
      value !== null && typeof value === 'object' && !Array.isArray(value);
    if (typeof e === 'number' && typeof a === 'number') {
      const tolerance = Math.max(FP_TOLERANCE, Math.abs(e) * FP_TOLERANCE);
      assert.ok(
        Math.abs(a - e) <= tolerance,
        `${context}: ${field} drifted (${a} vs ${e})`
      );
    } else if (isPlainObject(e) && isPlainObject(a)) {
      assertParity(a, e, `${context}.${field}`);
    } else {
      assert.deepEqual(a, e, `${context}: ${field}`);
    }
  }
}

function pickDecisionFields(result) {
  const picked = {};
  for (const field of DECISION_FIELDS) picked[field] = result[field];
  return picked;
}

test('라이브 평가기와 백테스트 평가기는 같은 완료 캔들에서 같은 결정을 내린다', () => {
  const chronological = chronologicalWindow();
  const liveInput = [{ ...chronological.at(-1), candle_date_time_utc: 'in-progress' },
    ...chronological.slice().reverse()];

  const live = calculateClosedCandleRebound(liveInput, SHARED_CONFIG);
  assert.equal(live.available, true);

  const rsiSeries = calculateRsiSeries(chronological, SHARED_CONFIG.rsiPeriod);
  const index = chronological.length - 1;
  const point = computeReboundPoint(chronological, index, rsiSeries, SHARED_CONFIG);
  const backtest = decideReboundSignal({ candles: chronological, index, point, rsiSeries, config: SHARED_CONFIG });
  assert.ok(backtest);

  // 라이브 전용 필드(OHLC 보조, nullable oversoldReferenceClose)는 shape
  // 계약이 다르므로 결정 필드만 대조한다.
  assertParity(pickDecisionFields(live), pickDecisionFields(backtest), 'live-vs-backtest');
});

test('튜닝 그리드 캐시의 피처 행은 표준 per-index 생성기와 동일하다', () => {
  const chronological = chronologicalWindow();
  const cache = createScalpingFeatureCache(chronological);
  const featureSet = cache.get(SHARED_CONFIG);
  const rsiSeries = featureSet.rsiSeries;

  for (const index of [SHARED_CONFIG.rsiPeriod + 1, 40, chronological.length - 1]) {
    const cached = featureSet.points[index];
    const canonical = computeReboundPoint(chronological, index, rsiSeries, SHARED_CONFIG);
    // trendConfirmed는 캐시 시점의 해석 설정으로 계산된 참고값이고, 결정은
    // trendSlopePercent에서 다시 계산하므로 대조 대상에서 제외한다.
    const { trendConfirmed: _c, ...cachedComparable } = cached;
    const { trendConfirmed: _k, ...canonicalComparable } = canonical;
    assertParity(cachedComparable, canonicalComparable, `feature row ${index}`);
  }
});

test('캐시 경로와 비캐시 경로의 신호 결정이 동일하다', () => {
  const chronological = chronologicalWindow();
  const cache = createScalpingFeatureCache(chronological);
  const featureSet = cache.get(SHARED_CONFIG);
  const rsiSeries = featureSet.rsiSeries;
  const index = chronological.length - 1;

  const viaCache = decideReboundSignal({
    candles: chronological,
    index,
    point: featureSet.points[index],
    rsiSeries,
    config: SHARED_CONFIG
  });
  const viaPoint = decideReboundSignal({
    candles: chronological,
    index,
    point: computeReboundPoint(chronological, index, rsiSeries, SHARED_CONFIG),
    rsiSeries,
    config: SHARED_CONFIG
  });

  assertParity(viaCache, viaPoint, 'cached-vs-plain decision');
});

test('momentum_breakout 프로파일에서도 라이브/백테스트 결정이 일치한다', () => {
  const chronological = chronologicalWindow();
  const config = { ...SHARED_CONFIG, signalProfile: 'momentum_breakout', rsiOversold: 1 };
  const liveInput = [chronological.at(-1), ...chronological.slice().reverse()];

  const live = calculateClosedCandleRebound(liveInput, config);
  const rsiSeries = calculateRsiSeries(chronological, config.rsiPeriod);
  const index = chronological.length - 1;
  const backtest = decideReboundSignal({
    candles: chronological,
    index,
    point: computeReboundPoint(chronological, index, rsiSeries, config),
    rsiSeries,
    config
  });

  assert.equal(live.available, true);
  assertParity(pickDecisionFields(live), pickDecisionFields(backtest), 'momentum parity');
});
