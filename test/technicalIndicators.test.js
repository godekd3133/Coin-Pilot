import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateClosedCandleRebound } from '../src/analysis/technicalIndicators.js';

function candle(close, open = close, timestamp) {
  return {
    trade_price: close,
    opening_price: open,
    high_price: Math.max(close, open),
    low_price: Math.min(close, open),
    candle_date_time_utc: timestamp
  };
}

test('진행 중 캔들을 제외하고 직전 과매도와 완료 양봉을 확인한다', () => {
  // 최신 데이터가 앞에 있다. index 0은 진행 중 캔들이다.
  const candles = [
    candle(101.1, 100.9, '2026-09-09T00:02:30'),
    candle(101, 100.5, '2026-09-09T00:02:00'),
    candle(100, 100.8, '2026-09-09T00:01:00'),
    ...Array.from({ length: 15 }, (_, index) => {
      const close = 101 + index;
      return candle(close, close + 0.5, `2026-09-08T23:${String(59 - index).padStart(2, '0')}:00`);
    })
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    minReboundPercent: 0.15,
    minRsiRecovery: 2
  });

  assert.equal(rebound.available, true);
  assert.equal(rebound.previousWasOversold, true);
  assert.equal(rebound.bullishCandle, true);
  assert.equal(rebound.reboundConfirmed, true);
  assert.equal(rebound.signalKey, '2026-09-09T00:02:00');
});

test('선택형 rebound overbought guard는 RSI가 과열된 반등을 차단한다', () => {
  const candles = [
    candle(101.1, 100.9, '2026-09-09T00:02:30'),
    candle(101, 100.5, '2026-09-09T00:02:00'),
    candle(100, 100.8, '2026-09-09T00:01:00'),
    ...Array.from({ length: 15 }, (_, index) => {
      const close = 101 + index;
      return candle(close, close + 0.5, `2026-09-08T23:${String(59 - index).padStart(2, '0')}:00`);
    })
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 1,
    requireReboundBelowOverbought: true,
    minReboundPercent: 0.15,
    minRsiRecovery: 2
  });

  assert.equal(rebound.reboundOverboughtConfirmed, false);
  assert.equal(rebound.reboundConfirmed, false);
  assert.ok(rebound.rejectionReasons.includes('rsi_overbought_blocked'));
});

test('신호 캔들 변동폭 상한을 넘으면 반등 진입을 차단한다', () => {
  const candles = [
    candle(101.1, 100.9, '2026-09-09T00:02:30'),
    candle(101, 100.5, '2026-09-09T00:02:00'),
    candle(100, 100.8, '2026-09-09T00:01:00'),
    ...Array.from({ length: 15 }, (_, index) => {
      const close = 101 + index;
      return candle(close, close + 0.5, `2026-09-08T23:${String(59 - index).padStart(2, '0')}:00`);
    })
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    minReboundPercent: 0.15,
    minRsiRecovery: 2,
    maxSignalRangePercent: 0.4
  });

  assert.equal(rebound.volatilityConfirmed, false);
  assert.ok(rebound.signalRangePercent > 0.4);
  assert.equal(rebound.reboundConfirmed, false);
  assert.ok(rebound.rejectionReasons.includes('signal_range_too_wide'));
});

test('신호 캔들 변동폭 하한보다 조용한 반등은 진입을 차단한다', () => {
  const candles = [
    candle(101.1, 100.9, '2026-09-09T00:02:30'),
    candle(101, 100.5, '2026-09-09T00:02:00'),
    candle(100, 100.8, '2026-09-09T00:01:00'),
    ...Array.from({ length: 15 }, (_, index) => candle(101 + index, 101.5 + index, `old-${index}`))
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    minReboundPercent: 0.15,
    minRsiRecovery: 2,
    minSignalRangePercent: 0.6
  });

  assert.equal(rebound.signalRangeFloorConfirmed, false);
  assert.equal(rebound.reboundConfirmed, false);
  assert.ok(rebound.rejectionReasons.includes('signal_range_too_narrow'));
});

test('완료 캔들 데이터가 부족하면 진입 신호를 만들지 않는다', () => {
  const rebound = calculateClosedCandleRebound(
    [candle(100), candle(99), candle(98)],
    { rsiPeriod: 14 }
  );

  assert.equal(rebound.available, false);
  assert.equal(rebound.reboundConfirmed, false);
});

test('직전 봉이 아니라 최근 3개 완료 봉 안의 과매도 반응도 포착한다', () => {
  // 최신 데이터가 앞에 있다. offset 2의 저점 봉만 과매도이고 offset 1은
  // 이미 회복된 상태지만, 최신 봉이 추가 양봉으로 확인되면 반등으로 본다.
  const olderDowntrend = Array.from({ length: 30 }, (_, index) => {
    const close = 90 + index;
    return candle(close, close + 0.5, `old-${index}`);
  });
  const candles = [
    candle(101.1, 101, '2026-09-09T00:03:00'),
    candle(101, 100, '2026-09-09T00:02:00'),
    candle(100, 90, '2026-09-09T00:01:00'),
    ...olderDowntrend
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    oversoldLookback: 3,
    minReboundPercent: 0.1,
    minRsiRecovery: 1,
    minCloseStrength: 0,
    minTrendSlopePercent: -100,
    requirePreviousHighBreak: false
  });

  assert.equal(rebound.previousRsi > 30, true);
  assert.equal(rebound.previousWasOversold, true);
  assert.equal(rebound.oversoldCandleAge, 2);
  assert.equal(rebound.reboundConfirmed, true);
});

test('볼린저 재진입 프로파일은 하단 재진입이 없으면 RSI 반등만으로 BUY하지 않는다', () => {
  const candles = [
    candle(101.1, 100.9, '2026-09-09T00:02:30'),
    candle(101, 100.5, '2026-09-09T00:02:00'),
    candle(100, 100.8, '2026-09-09T00:01:00'),
    ...Array.from({ length: 15 }, (_, index) => candle(101 + index, 101.5 + index, `old-${index}`))
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    minReboundPercent: 0.15,
    minRsiRecovery: 2,
    signalProfile: 'bb_reclaim',
    bbPeriod: 5,
    bbStdDev: 2
  });

  assert.equal(rebound.profileConfirmed, false);
  assert.equal(rebound.reboundConfirmed, false);
});

test('momentum_breakout 프로파일은 과매도 조건 대신 EMA와 직전 고가 돌파를 확인한다', () => {
  const candles = [
    candle(101.1, 100.9, '2026-09-09T00:02:30'),
    candle(101, 100.5, '2026-09-09T00:02:00'),
    candle(100, 99.8, '2026-09-09T00:01:00'),
    ...Array.from({ length: 15 }, (_, index) => candle(98 + index * 0.2, 97.9 + index * 0.2, `old-${index}`))
  ];

  const rebound = calculateClosedCandleRebound(candles, {
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    minReboundPercent: 0.15,
    minRsiRecovery: 0,
    minVolumeRatio: 0,
    minCloseStrength: 0,
    minTrendSlopePercent: -100,
    requirePreviousHighBreak: true,
    signalProfile: 'momentum_breakout',
    emaPeriod: 2
  });

  assert.equal(rebound.previousWasOversold, false);
  assert.equal(rebound.previousHighBreak, true);
  assert.equal(rebound.momentumRsiConfirmed, true);
  assert.equal(rebound.reboundConfirmed, true);
});
