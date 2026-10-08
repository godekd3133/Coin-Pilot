import express from 'express';
import { resolveMaxCandleAgeSeconds } from '../../risk/candleFreshness.js';
import { getPaperEvidenceMutationLock, respondIfPaperEvidenceMutationBlocked } from '../../research/paperEvidenceMutationGuard.js';
import { describeLiveTradingFailure } from '../../research/strategyReadiness.js';
import { getMarketDataProvider, MARKET_DATA_FRESHNESS } from '../marketDataProvider.js';

const MOBILE_INVESTMENT_PRESETS = {
  aggressive: {
    rsiPeriod: 7, rsiOversold: 25, rsiOverbought: 75, macdFast: 8, macdSlow: 17, macdSignal: 7,
    bbPeriod: 15, bbStdDev: 1.5, emaShort: 5, emaMid: 15, emaLong: 30, stopLossPercent: 3,
    takeProfitPercent: 15, trailingStopPercent: 2, buyThreshold: 50, sellThreshold: 50,
    volumeMultiplier: 1.2, volumePeriod: 10, investmentRatio: 0.15
  },
  conservative: {
    rsiPeriod: 21, rsiOversold: 20, rsiOverbought: 80, macdFast: 15, macdSlow: 30, macdSignal: 12,
    bbPeriod: 25, bbStdDev: 2.5, emaShort: 15, emaMid: 40, emaLong: 100, stopLossPercent: 8,
    takeProfitPercent: 6, trailingStopPercent: 4, buyThreshold: 70, sellThreshold: 70,
    volumeMultiplier: 2, volumePeriod: 30, investmentRatio: 0.03
  },
  shortterm: {
    rsiPeriod: 9, rsiOversold: 28, rsiOverbought: 72, macdFast: 9, macdSlow: 21, macdSignal: 8,
    bbPeriod: 18, bbStdDev: 1.8, emaShort: 7, emaMid: 21, emaLong: 50, stopLossPercent: 4,
    takeProfitPercent: 8, trailingStopPercent: 2.5, buyThreshold: 55, sellThreshold: 55,
    volumeMultiplier: 1.5, volumePeriod: 15, investmentRatio: 0.1
  },
  scalping: {
    rsiPeriod: 5, rsiOversold: 30, rsiOverbought: 70, macdFast: 5, macdSlow: 13, macdSignal: 5,
    bbPeriod: 10, bbStdDev: 1.2, emaShort: 3, emaMid: 8, emaLong: 20, stopLossPercent: 1.2,
    takeProfitPercent: 1.8, trailingStopPercent: 1, buyThreshold: 45, sellThreshold: 45,
    volumeMultiplier: 2.5, volumePeriod: 5, investmentRatio: 0.02, minReboundPercent: 0.15,
    minRsiRecovery: 2, minVolumeRatio: 0.8, minCloseStrength: 0.55, trendPeriod: 30,
    trendSlopeLookback: 3, minTrendSlopePercent: -0.5, entryDelayMinMs: 1000,
    entryDelayMaxMs: 5000, maxEntryRetracePercent: 0.25, maxEntryChasePercent: 0.35, maxHoldMinutes: 30
  },
  longterm: {
    rsiPeriod: 28, rsiOversold: 20, rsiOverbought: 80, macdFast: 19, macdSlow: 39, macdSignal: 14,
    bbPeriod: 30, bbStdDev: 2.2, emaShort: 20, emaMid: 60, emaLong: 200, stopLossPercent: 12,
    takeProfitPercent: 25, trailingStopPercent: 5, buyThreshold: 65, sellThreshold: 65,
    volumeMultiplier: 1.3, volumePeriod: 40, investmentRatio: 0.05
  },
  balanced: {
    rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, macdFast: 12, macdSlow: 26, macdSignal: 9,
    bbPeriod: 20, bbStdDev: 2, emaShort: 10, emaMid: 30, emaLong: 60, stopLossPercent: 5,
    takeProfitPercent: 10, trailingStopPercent: 3, buyThreshold: 60, sellThreshold: 60,
    volumeMultiplier: 1.5, volumePeriod: 20, investmentRatio: 0.05
  }
};

const CONFIGURATION_RANGES = {
  investmentRatio: [0.01, 1],
  rsiPeriod: [2, 100], rsiOversold: [1, 50], rsiOverbought: [50, 99], oversoldLookback: [1, 10],
  macdFast: [1, 100], macdSlow: [2, 200], macdSignal: [1, 100], bbPeriod: [2, 200], bbStdDev: [0.1, 10],
  emaShort: [1, 100], emaMid: [2, 200], emaLong: [3, 500], stopLossPercent: [0.1, 100],
  takeProfitPercent: [0.1, 1000], trailingStopPercent: [0, 5], minReboundPercent: [0.01, 5],
  maxReboundPercent: [0, 10], minRsiRecovery: [0.1, 30], minVolumeRatio: [0, 10], minCloseStrength: [0, 1],
  trendPeriod: [5, 240], trendSlopeLookback: [1, 30], minTrendSlopePercent: [-10, 10],
  maxSignalRangePercent: [0, 10], minSignalRangePercent: [0, 10], marketRegimeLookback: [1, 60],
  marketRegimeMinBreadth: [0, 1], marketRegimeMinReturnPercent: [-10, 10],
  positionRiskCheckIntervalMs: [250, 10_000], maxRiskDataGapSeconds: [5, 600],
  maxAnalysisDataGapSeconds: [5, 600], maxCandleAgeSeconds: [60, 900], entryDelayMinMs: [1000, 5000],
  entryDelayMaxMs: [1000, 5000], maxEntryRetracePercent: [0.01, 5], maxEntryChasePercent: [0.01, 5],
  breakEvenTriggerPercent: [0, 5], breakEvenOffsetPercent: [0, 1], trailingActivationPercent: [0, 10],
  maxHoldMinutes: [1, 240], maxLosingHoldMinutes: [0, 240], winnerExtendMinutes: [0, 240],
  winnerExtendMinProfitPercent: [0, 5], maxEntriesPerSignalWindow: [0, 20],
  lossCircuitBreakerCount: [0, 20], lossCircuitBreakerWindowMinutes: [1, 1440],
  lossCircuitBreakerCooldownMinutes: [1, 1440], buyThreshold: [0, 100], sellThreshold: [0, 100],
  volumeMultiplier: [0.1, 100], volumePeriod: [1, 200]
};
const BOOLEAN_CONFIGURATION_KEYS = new Set(['marketRegimeEnabled', 'requireReboundBelowOverbought']);

/**
 * 설정/제어 관련 라우트
 */
export default function createConfigRoutes(server) {
  const router = express.Router();

  // 파라미터 범위 조회
  router.get('/parameter-ranges', (req, res) => {
    res.json({
      investmentRatio: { min: 0.01, max: 1.0, step: 0.01, label: '1회 투자 비율 (%)', description: '총 자산 중 한 번의 거래에 사용할 비율 (1%~100%)', category: 'Investment', displayMultiplier: 100 },
      rsiPeriod: { min: 2, max: 100, step: 1, label: 'RSI 기간', description: 'RSI 계산에 사용할 기간 (2~100)', category: 'RSI' },
      rsiOversold: { min: 1, max: 50, step: 1, label: 'RSI 과매도', description: '과매도 판단 기준값 (1~50)', category: 'RSI' },
      oversoldLookback: { min: 1, max: 10, step: 1, label: '과매도 탐색 범위', description: '최근 완료 봉 중 과매도 상태를 찾을 최대 범위 (기본 1; 후보 3)', category: 'Scalping' },
      rsiOverbought: { min: 50, max: 99, step: 1, label: 'RSI 과매수', description: '과매수 판단 기준값 (50~99)', category: 'RSI' },
      macdFast: { min: 1, max: 100, step: 1, label: 'MACD 빠른선 기간', description: 'MACD에서 빠른 이동평균을 계산할 기간 (1~100)', category: 'MACD' },
      macdSlow: { min: 2, max: 200, step: 1, label: 'MACD 느린선 기간', description: 'MACD에서 느린 이동평균을 계산할 기간 (2~200)', category: 'MACD' },
      macdSignal: { min: 1, max: 100, step: 1, label: 'MACD 신호선 기간', description: 'MACD 신호선을 계산할 기간 (1~100)', category: 'MACD' },
      bbPeriod: { min: 2, max: 200, step: 1, label: '볼린저 밴드 기간', description: '볼린저 밴드 중심선을 계산할 기간 (2~200)', category: '볼린저 밴드' },
      bbStdDev: { min: 0.1, max: 10, step: 0.1, label: '볼린저 밴드 폭 배수', description: '중심선에서 밴드까지의 폭을 정하는 배수 (0.1~10)', category: '볼린저 밴드' },
      emaShort: { min: 1, max: 100, step: 1, label: '단기 지수이동평균 기간', description: '짧은 가격 흐름을 계산할 기간 (1~100)', category: 'EMA' },
      emaMid: { min: 2, max: 200, step: 1, label: '중기 지수이동평균 기간', description: '중간 가격 흐름을 계산할 기간 (2~200)', category: 'EMA' },
      emaLong: { min: 3, max: 500, step: 1, label: '장기 지수이동평균 기간', description: '긴 가격 흐름을 계산할 기간 (3~500)', category: 'EMA' },
      stopLossPercent: { min: 0.1, max: 100, step: 0.1, label: '손절률 (%)', description: '손절 실행 기준 하락률 (0.1%~100%)', category: 'Trading' },
      takeProfitPercent: { min: 0.1, max: 1000, step: 0.1, label: '익절률 (%)', description: '익절 실행 기준 상승률 (0.1%~1000%)', category: 'Trading' },
      trailingStopPercent: { min: 0, max: 5, step: 0.05, label: '고점 대비 허용 하락률 (%)', description: '0은 사용하지 않음. 설정하면 고점에서 이 비율만큼 내려갔을 때 청산합니다 (최대 5%)', category: 'Trading' },
      minReboundPercent: { min: 0.01, max: 5, step: 0.01, label: '최소 반등률 (%)', description: '과매도 이후 완료 캔들의 최소 반등률', category: 'Scalping' },
      maxReboundPercent: { min: 0, max: 10, step: 0.05, label: '최대 반등률 (%)', description: '0은 사용하지 않음. 이미 크게 오른 캔들을 뒤늦게 따라 사지 않도록 제한합니다.', category: 'Scalping' },
      minRsiRecovery: { min: 0.1, max: 30, step: 0.1, label: '최소 RSI 회복', description: '직전 완료 캔들 대비 RSI 회복 폭', category: 'Scalping' },
      minVolumeRatio: { min: 0, max: 10, step: 0.1, label: '최소 거래량 배수', description: '반등 캔들의 과거 평균 대비 최소 거래량', category: 'Scalping' },
      minCloseStrength: { min: 0, max: 1, step: 0.05, label: '캔들 종가 위치 기준', description: '캔들 고가와 저가 사이에서 종가가 있어야 하는 최소 비율', category: 'Scalping' },
      trendPeriod: { min: 5, max: 240, step: 1, label: '추세 확인 기간', description: '반등 전 가격 흐름을 확인할 완료 캔들 수', category: 'Scalping' },
      trendSlopeLookback: { min: 1, max: 30, step: 1, label: '추세 비교 간격', description: '현재 추세와 비교할 과거 캔들 간격', category: 'Scalping' },
      minTrendSlopePercent: { min: -10, max: 10, step: 0.1, label: '최소 추세 변화율 (%)', description: '강한 하락 흐름에서 새로 진입하지 않도록 하는 기준', category: 'Scalping' },
      maxSignalRangePercent: { min: 0, max: 10, step: 0.1, label: '신호 캔들 변동폭 상한 (%)', description: '급변 캔들 진입을 제한하는 고가-저가 범위 상한 (0은 비활성)', category: 'Scalping' },
      minSignalRangePercent: { min: 0, max: 10, step: 0.1, label: '신호 캔들 변동폭 하한 (%)', description: '조용한 반등을 제한하는 고가-저가 범위 하한 (0은 비활성)', category: 'Scalping' },
      marketRegimeLookback: { min: 1, max: 60, step: 1, label: '시장 방향 비교 기간', description: '전체 대상 시장의 단기 방향을 비교할 완료 캔들 간격', category: 'Scalping' },
      marketRegimeMinBreadth: { min: 0, max: 1, step: 0.05, label: '상승 종목 비율 하한', description: '전체 대상 중 이 비율 이상이 상승해야 신규 진입을 허용합니다 (0~1)', category: 'Risk' },
      marketRegimeMinReturnPercent: { min: -10, max: 10, step: 0.1, label: '상승 종목 판정 기준 (%)', description: '조회 기간 수익률이 이 값 이상인 종목을 상승으로 셉니다.', category: 'Risk' },
      positionRiskCheckIntervalMs: { min: 250, max: 10000, step: 250, label: '보유 자산 위험 확인 주기 (밀리초)', description: '열린 포지션의 손절·익절·최대 보유 시간을 다시 확인하는 간격', category: 'Risk' },
      maxRiskDataGapSeconds: { min: 5, max: 600, step: 5, label: '위험 확인 시세 공백 한도 (초)', description: '보유 자산의 시세를 이 시간 이상 확인하지 못하면 자동매매를 중지합니다.', category: 'Risk' },
      maxAnalysisDataGapSeconds: { min: 5, max: 600, step: 5, label: '시장 분석 공백 한도 (초)', description: '전체 시장 분석이 이 시간 이상 불완전하면 자동매매를 중지합니다.', category: 'Risk' },
      maxCandleAgeSeconds: { min: 60, max: 900, step: 30, label: '최대 캔들 경과 시간 (초)', description: '진입 시 최신 캔들이 이 시간보다 오래됐으면 주문을 막습니다 (1분봉 기본 90초)', category: 'Risk' },
      entryDelayMinMs: { min: 1000, max: 5000, step: 100, label: '최소 재확인 대기 시간 (밀리초)', description: '반등 신호를 확인한 뒤 기다릴 최소 시간', category: 'Scalping' },
      entryDelayMaxMs: { min: 1000, max: 5000, step: 100, label: '최대 재확인 대기 시간 (밀리초)', description: '반등 신호를 확인한 뒤 기다릴 최대 시간', category: 'Scalping' },
      maxEntryRetracePercent: { min: 0.01, max: 5, step: 0.01, label: '진입 전 허용 하락률 (%)', description: '재확인 대기 중 반등 고점에서 허용할 하락폭', category: 'Scalping' },
      maxEntryChasePercent: { min: 0.01, max: 5, step: 0.01, label: '진입 전 허용 상승률 (%)', description: '재확인 대기 중 추격 매수를 막기 위한 상승폭 제한', category: 'Scalping' },
      breakEvenTriggerPercent: { min: 0, max: 5, step: 0.05, label: '진입가 보호 시작 (%)', description: '0은 사용하지 않음. 수익이 이 값에 도달하면 진입가 보호를 시작합니다', category: 'Risk' },
      breakEvenOffsetPercent: { min: 0, max: 1, step: 0.01, label: '진입가 보호 여유폭 (%)', description: '보호 가격을 진입가보다 높게 설정할 비율', category: 'Risk' },
      trailingActivationPercent: { min: 0, max: 10, step: 0.05, label: '고점 추적 보호 시작 (%)', description: '0은 사용하지 않음. 수익이 이 값에 도달하면 고점 대비 하락을 확인합니다', category: 'Risk' },
      maxHoldMinutes: { min: 1, max: 240, step: 1, label: '최대 보유 시간 (분)', description: '스캘핑 포지션의 최대 보유 시간', category: 'Scalping' },
      maxLosingHoldMinutes: { min: 0, max: 240, step: 1, label: '손실 중인 포지션 최대 보유 시간 (분)', description: '0은 사용하지 않음. 설정 시간이 지나도 손실 중인 포지션만 먼저 정리합니다.', category: 'Risk' },
      winnerExtendMinutes: { min: 0, max: 240, step: 1, label: '수익 중인 포지션 연장 시간 (분)', description: '0은 사용하지 않음. 최대 보유 시간이 지나도 수익 중이면 진입가 보호와 함께 보유 시간을 연장합니다.', category: 'Risk' },
      winnerExtendMinProfitPercent: { min: 0, max: 5, step: 0.05, label: '연장에 필요한 최소 수익률 (%)', description: '진입가 대비 보유 시간을 연장할 수 있는 최소 수익률', category: 'Risk' },
      maxEntriesPerSignalWindow: { min: 0, max: 20, step: 1, label: '한 캔들의 최대 진입 횟수', description: '같은 완료 캔들에서 허용할 전체 진입 횟수 (0은 제한 없음)', category: 'Risk' },
      lossCircuitBreakerCount: { min: 0, max: 20, step: 1, label: '손실 차단 기준 횟수', description: '최근 확인 기간에 이 횟수만큼 손실이 발생하면 새 진입을 멈춥니다 (0은 사용하지 않음)', category: 'Risk' },
      lossCircuitBreakerWindowMinutes: { min: 1, max: 1440, step: 1, label: '손실 횟수 확인 기간 (분)', description: '손실 횟수를 셀 최근 시간 범위', category: 'Risk' },
      lossCircuitBreakerCooldownMinutes: { min: 1, max: 1440, step: 1, label: '손실 차단 후 대기 시간 (분)', description: '손실 차단이 시작된 뒤 새 진입을 막아 둘 시간', category: 'Risk' },
      buyThreshold: { min: 0, max: 100, step: 1, label: '매수 기준 점수', description: '매수 신호를 판단할 점수 기준 (0~100)', category: 'Trading' },
      sellThreshold: { min: 0, max: 100, step: 1, label: '매도 기준 점수', description: '매도 신호를 판단할 점수 기준 (0~100)', category: 'Trading' },
      volumeMultiplier: { min: 0.1, max: 100, step: 0.1, label: '거래량 배수', description: '평균 대비 거래량 배수 기준 (0.1~100)', category: 'Volume' },
      volumePeriod: { min: 1, max: 200, step: 1, label: '거래량 기간', description: '거래량 평균 계산 기간 (1~200)', category: 'Volume' }
    });
  });

  // 투자 성향 프리셋 조회
  router.get('/investment-presets', (req, res) => {
    res.json({
      presets: [
        {
          id: 'aggressive',
          name: '공격적 투자',
          nameEn: 'Aggressive',
          description: '가격 변동에 적극적으로 대응하도록 설정합니다. 손실 폭도 커질 수 있습니다.',
          icon: '🔥',
          riskLevel: 5,
          config: {
            rsiPeriod: 7, rsiOversold: 25, rsiOverbought: 75,
            macdFast: 8, macdSlow: 17, macdSignal: 7,
            bbPeriod: 15, bbStdDev: 1.5,
            emaShort: 5, emaMid: 15, emaLong: 30,
            stopLossPercent: 3, takeProfitPercent: 15, trailingStopPercent: 2,
            buyThreshold: 50, sellThreshold: 50,
            volumeMultiplier: 1.2, volumePeriod: 10,
            investmentRatio: 0.15
          }
        },
        {
          id: 'conservative',
          name: '보수적 투자',
          nameEn: 'Conservative',
          description: '거래 빈도와 1회 투자 비중을 낮춘 설정입니다. 손실을 막거나 수익을 보장하지는 않습니다.',
          icon: '🛡️',
          riskLevel: 1,
          config: {
            rsiPeriod: 21, rsiOversold: 20, rsiOverbought: 80,
            macdFast: 15, macdSlow: 30, macdSignal: 12,
            bbPeriod: 25, bbStdDev: 2.5,
            emaShort: 15, emaMid: 40, emaLong: 100,
            stopLossPercent: 8, takeProfitPercent: 6, trailingStopPercent: 4,
            buyThreshold: 70, sellThreshold: 70,
            volumeMultiplier: 2.0, volumePeriod: 30,
            investmentRatio: 0.03
          }
        },
        {
          id: 'shortterm',
          name: '단타 매매',
          nameEn: 'Short-term Trading',
          description: '몇 시간에서 며칠 사이의 가격 변동을 기준으로 거래합니다. 손실이 발생할 수 있습니다.',
          icon: '⚡',
          riskLevel: 4,
          config: {
            rsiPeriod: 9, rsiOversold: 28, rsiOverbought: 72,
            macdFast: 9, macdSlow: 21, macdSignal: 8,
            bbPeriod: 18, bbStdDev: 1.8,
            emaShort: 7, emaMid: 21, emaLong: 50,
            stopLossPercent: 4, takeProfitPercent: 8, trailingStopPercent: 2.5,
            buyThreshold: 55, sellThreshold: 55,
            volumeMultiplier: 1.5, volumePeriod: 15,
            investmentRatio: 0.10
          }
        },
        {
          id: 'scalping',
          name: '초단타 (스캘핑)',
          nameEn: 'Scalping',
          description: '분 단위 가격 움직임에 맞춘 설정입니다. 거래가 잦아지거나 손실이 빠르게 발생할 수 있습니다.',
          icon: '💨',
          riskLevel: 5,
          config: {
            rsiPeriod: 5, rsiOversold: 30, rsiOverbought: 70,
            macdFast: 5, macdSlow: 13, macdSignal: 5,
            bbPeriod: 10, bbStdDev: 1.2,
            emaShort: 3, emaMid: 8, emaLong: 20,
            stopLossPercent: 1.2, takeProfitPercent: 1.8, trailingStopPercent: 1,
            buyThreshold: 45, sellThreshold: 45,
            volumeMultiplier: 2.5, volumePeriod: 5,
            investmentRatio: 0.02,
            minReboundPercent: 0.15,
            minRsiRecovery: 2,
            minVolumeRatio: 0.8,
            minCloseStrength: 0.55,
            trendPeriod: 30,
            trendSlopeLookback: 3,
            minTrendSlopePercent: -0.5,
            entryDelayMinMs: 1000,
            entryDelayMaxMs: 5000,
            maxEntryRetracePercent: 0.25,
            maxEntryChasePercent: 0.35,
            maxHoldMinutes: 30
          }
        },
        {
          id: 'longterm',
          name: '장기 투자',
          nameEn: 'Long-term Investment',
          description: '몇 주에서 몇 달의 가격 흐름을 기준으로 합니다. 가격 하락과 원금 손실이 발생할 수 있습니다.',
          icon: '🏦',
          riskLevel: 2,
          config: {
            rsiPeriod: 28, rsiOversold: 20, rsiOverbought: 80,
            macdFast: 19, macdSlow: 39, macdSignal: 14,
            bbPeriod: 30, bbStdDev: 2.2,
            emaShort: 20, emaMid: 60, emaLong: 200,
            stopLossPercent: 12, takeProfitPercent: 25, trailingStopPercent: 5,
            buyThreshold: 65, sellThreshold: 65,
            volumeMultiplier: 1.3, volumePeriod: 40,
            investmentRatio: 0.05
          }
        },
        {
          id: 'balanced',
          name: '균형 투자',
          nameEn: 'Balanced',
          description: '투자 비중과 거래 조건을 중간 수준으로 설정합니다. 수익이나 손실을 보장하지 않습니다.',
          icon: '⚖️',
          riskLevel: 3,
          config: {
            rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70,
            macdFast: 12, macdSlow: 26, macdSignal: 9,
            bbPeriod: 20, bbStdDev: 2.0,
            emaShort: 10, emaMid: 30, emaLong: 60,
            stopLossPercent: 5, takeProfitPercent: 10, trailingStopPercent: 3,
            buyThreshold: 60, sellThreshold: 60,
            volumeMultiplier: 1.5, volumePeriod: 20,
            investmentRatio: 0.05
          }
        }
      ]
    });
  });

  // 투자 프리셋 적용
  router.post('/investment-presets/apply', (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'investment_preset_apply')) return;
    try {
      const presetId = typeof req.body?.presetId === 'string' ? req.body.presetId : null;
      const config = presetId ? MOBILE_INVESTMENT_PRESETS[presetId] : req.body?.config;

      if (!config) {
        return res.status(400).json({ error: '프리셋 설정이 없습니다', success: false });
      }

      Object.assign(server.tradingSystem.config, {
        rsiPeriod: config.rsiPeriod,
        rsiOversold: config.rsiOversold,
        rsiOverbought: config.rsiOverbought,
        macdFast: config.macdFast,
        macdSlow: config.macdSlow,
        macdSignal: config.macdSignal,
        bbPeriod: config.bbPeriod,
        bbStdDev: config.bbStdDev,
        emaShort: config.emaShort,
        emaMid: config.emaMid,
        emaLong: config.emaLong,
        stopLossPercent: config.stopLossPercent,
        takeProfitPercent: config.takeProfitPercent,
        trailingStopPercent: config.trailingStopPercent,
        buyThreshold: config.buyThreshold,
        sellThreshold: config.sellThreshold,
        volumeMultiplier: config.volumeMultiplier,
        volumePeriod: config.volumePeriod,
        minReboundPercent: config.minReboundPercent,
        minRsiRecovery: config.minRsiRecovery,
        oversoldLookback: config.oversoldLookback,
        minVolumeRatio: config.minVolumeRatio,
        minCloseStrength: config.minCloseStrength,
        trendPeriod: config.trendPeriod,
        trendSlopeLookback: config.trendSlopeLookback,
        minTrendSlopePercent: config.minTrendSlopePercent,
        maxSignalRangePercent: config.maxSignalRangePercent,
        entryDelayMinMs: config.entryDelayMinMs,
        entryDelayMaxMs: config.entryDelayMaxMs,
        maxEntryRetracePercent: config.maxEntryRetracePercent,
        maxEntryChasePercent: config.maxEntryChasePercent,
        maxHoldMinutes: config.maxHoldMinutes
      });

      if (server.tradingSystem.strategyConfig) {
        Object.assign(server.tradingSystem.strategyConfig, {
          stopLossPercent: config.stopLossPercent,
          takeProfitPercent: config.takeProfitPercent,
          oversoldLookback: config.oversoldLookback,
          buyThreshold: config.buyThreshold,
          sellThreshold: config.sellThreshold
        });
      }

      if (server.tradingSystem.strategies && server.tradingSystem.strategies.size > 0) {
        for (const strategy of server.tradingSystem.strategies.values()) {
          if (strategy && strategy.config) {
            strategy.config.stopLossPercent = config.stopLossPercent;
            strategy.config.takeProfitPercent = config.takeProfitPercent;
            strategy.config.buyThreshold = config.buyThreshold;
            strategy.config.sellThreshold = config.sellThreshold;
          }
        }
      }

      if (config.investmentRatio !== undefined) {
        server.tradingSystem.investmentRatio = config.investmentRatio;
      }

      if (server.tradingSystem.isScalpingMode) {
        const scalpingKeys = [
          'minReboundPercent',
          'maxReboundPercent',
          'minRsiRecovery',
          'oversoldLookback',
          'entryDelayMinMs',
          'entryDelayMaxMs',
          'maxEntryRetracePercent',
          'maxEntryChasePercent',
          'breakEvenTriggerPercent',
          'breakEvenOffsetPercent',
          'trailingActivationPercent',
          'trailingStopPercent',
          'maxHoldMinutes',
          'maxLosingHoldMinutes',
          'winnerExtendMinutes',
          'winnerExtendMinProfitPercent',
          'maxEntriesPerSignalWindow',
          'maxSignalRangePercent',
          'minSignalRangePercent',
          'marketRegimeEnabled',
          'marketRegimeLookback',
          'marketRegimeMinBreadth',
          'marketRegimeMinReturnPercent',
          'requireReboundBelowOverbought',
          'lossCircuitBreakerCount',
          'lossCircuitBreakerWindowMinutes',
          'lossCircuitBreakerCooldownMinutes',
          'positionRiskCheckIntervalMs',
          'maxRiskDataGapSeconds',
          'maxAnalysisDataGapSeconds',
          'maxCandleAgeSeconds'
        ];
        for (const key of scalpingKeys) {
          if (config[key] === undefined) continue;
          server.tradingSystem.config[key] = config[key];
            if (key === 'entryDelayMinMs' || key === 'entryDelayMaxMs' || key === 'maxEntryRetracePercent' || key === 'maxEntryChasePercent' ||
              key === 'breakEvenTriggerPercent' || key === 'breakEvenOffsetPercent' || key === 'trailingActivationPercent' || key === 'trailingStopPercent') {
              server.tradingSystem[key] = config[key];
          }
          if (server.tradingSystem.strategyConfig) {
            server.tradingSystem.strategyConfig[key] = config[key];
          }
          for (const strategy of server.tradingSystem.strategies?.values() || []) {
            if (strategy?.config) strategy.config[key] = config[key];
            if (key === 'entryDelayMinMs' || key === 'entryDelayMaxMs' || key === 'maxEntryRetracePercent' || key === 'maxEntryChasePercent' ||
              key === 'breakEvenTriggerPercent' || key === 'breakEvenOffsetPercent' || key === 'trailingActivationPercent' || key === 'trailingStopPercent') {
              strategy[key] = config[key];
            }
          if (key === 'maxHoldMinutes') {
            strategy.maxHoldMs = Number(config[key]) * 60 * 1000;
          }
            if (key === 'positionRiskCheckIntervalMs') {
              server.tradingSystem.positionRiskCheckIntervalMs = Math.max(250, Number(config[key]) || 1000);
              server.tradingSystem.stopPositionRiskMonitor();
              if (server.tradingSystem.isRunning) server.tradingSystem.startPositionRiskMonitor();
            }
            if (key === 'maxRiskDataGapSeconds') {
              server.tradingSystem.maxRiskDataGapSeconds = Math.max(5, Number(config[key]) || 30);
              server.tradingSystem.config.maxRiskDataGapSeconds = server.tradingSystem.maxRiskDataGapSeconds;
            }
            if (key === 'maxCandleAgeSeconds') {
              server.tradingSystem.maxCandleAgeSeconds = resolveMaxCandleAgeSeconds(
                config[key],
                server.tradingSystem.candleUnit
              );
              server.tradingSystem.config.maxCandleAgeSeconds = server.tradingSystem.maxCandleAgeSeconds;
            }
          }
        }
        if (config.maxAnalysisDataGapSeconds !== undefined) {
          server.tradingSystem.maxAnalysisDataGapSeconds = Math.max(5, Number(config.maxAnalysisDataGapSeconds) || 60);
          server.tradingSystem.config.maxAnalysisDataGapSeconds = server.tradingSystem.maxAnalysisDataGapSeconds;
        }
      }

      res.json({
        success: true,
        message: '투자 설정을 적용했습니다.',
        appliedConfig: config
      });
    } catch {
      res.status(500).json({ error: '투자 설정을 적용하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  // 현재 투자 설정 조회
  router.get('/investment-config', (req, res) => {
    try {
      res.json({
        investmentRatio: server.tradingSystem.investmentRatio ?? 0.05,
        initialSeedMoney: server.tradingSystem.initialSeedMoney ?? 0,
        strategyMode: server.tradingSystem.strategyMode,
        targetCoins: server.tradingSystem.targetCoins || [],
        scalpMaxMarkets: server.tradingSystem.config?.maxScalpMarkets ?? null,
        maxPositions: server.tradingSystem.maxPositions ?? null,
        scalping: server.tradingSystem.isScalpingMode ? {
          ...Object.fromEntries(Object.keys(CONFIGURATION_RANGES)
            .filter(key => key !== 'investmentRatio' && server.tradingSystem.config?.[key] !== undefined)
            .map(key => [key, server.tradingSystem.config[key]])),
          candleUnit: server.tradingSystem.candleUnit,
          candleCount: server.tradingSystem.candleCount,
          entryDelayMinMs: server.tradingSystem.entryDelayMinMs,
          entryDelayMaxMs: server.tradingSystem.entryDelayMaxMs,
          maxEntryRetracePercent: server.tradingSystem.maxEntryRetracePercent,
          maxEntryChasePercent: server.tradingSystem.strategyConfig?.maxEntryChasePercent,
          breakEvenTriggerPercent: server.tradingSystem.config?.breakEvenTriggerPercent,
          breakEvenOffsetPercent: server.tradingSystem.config?.breakEvenOffsetPercent,
          trailingActivationPercent: server.tradingSystem.config?.trailingActivationPercent,
          trailingStopPercent: server.tradingSystem.config?.trailingStopPercent,
          maxLosingHoldMinutes: server.tradingSystem.config?.maxLosingHoldMinutes ?? 0,
          winnerExtendMinutes: server.tradingSystem.config?.winnerExtendMinutes ?? 0,
          winnerExtendMinProfitPercent: server.tradingSystem.config?.winnerExtendMinProfitPercent ?? 0,
          maxEntriesPerSignalWindow: server.tradingSystem.config?.maxEntriesPerSignalWindow ?? 0,
          maxCandleAgeSeconds: server.tradingSystem.maxCandleAgeSeconds,
          oversoldLookback: server.tradingSystem.config?.oversoldLookback,
          maxSignalRangePercent: server.tradingSystem.config?.maxSignalRangePercent,
          minSignalRangePercent: server.tradingSystem.config?.minSignalRangePercent,
          maxReboundPercent: server.tradingSystem.config?.maxReboundPercent ?? 0,
          marketRegimeEnabled: server.tradingSystem.config?.marketRegimeEnabled === true,
          marketRegimeLookback: server.tradingSystem.config?.marketRegimeLookback ?? 5,
          marketRegimeMinBreadth: server.tradingSystem.config?.marketRegimeMinBreadth ?? 0.5,
          marketRegimeMinReturnPercent: server.tradingSystem.config?.marketRegimeMinReturnPercent ?? -0.2,
          requireReboundBelowOverbought: server.tradingSystem.config?.requireReboundBelowOverbought === true,
          lossCircuitBreakerCount: server.tradingSystem.config?.lossCircuitBreakerCount,
          lossCircuitBreakerWindowMinutes: server.tradingSystem.config?.lossCircuitBreakerWindowMinutes,
          lossCircuitBreakerCooldownMinutes: server.tradingSystem.config?.lossCircuitBreakerCooldownMinutes,
          lossCircuitBreaker: typeof server.tradingSystem.getLossCircuitBreakerStatus === 'function'
            ? server.tradingSystem.getLossCircuitBreakerStatus('strict')
            : null,
          positionRiskCheckIntervalMs: server.tradingSystem.positionRiskCheckIntervalMs,
          maxRiskDataGapSeconds: server.tradingSystem.maxRiskDataGapSeconds,
          maxAnalysisDataGapSeconds: server.tradingSystem.maxAnalysisDataGapSeconds,
          maxPositions: server.tradingSystem.maxPositions
        } : null,
        evidenceMutationLock: getPaperEvidenceMutationLock(server.tradingSystem, 'configuration'),
        minOrderAmount: 5000
      });
    } catch {
      res.status(500).json({ error: '투자 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  // 투자 설정 업데이트
  router.post('/investment-config/update', (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'investment_config_update')) return;
    try {
      const updates = req.body;

      if (updates.investmentRatio !== undefined) {
        server.tradingSystem.investmentRatio = Math.max(0.01, Math.min(1.0, parseFloat(updates.investmentRatio)));
      }

      res.json({
        success: true,
        message: '투자 비율을 저장했습니다.',
        config: {
          investmentRatio: server.tradingSystem.investmentRatio,
          minOrderAmount: 5000
        }
      });
    } catch {
      res.status(500).json({ error: '투자 비율을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  // 시스템 시작
  router.post('/control/start', (req, res) => {
    const trader = server.tradingSystem;
    if (trader.isRunning || trader._startPromise || trader._gracefulShutdownPromise) {
      // 이미 실행 중이면 운영자의 "켜기" 의도만 재확인한다.
      if (!trader._gracefulShutdownPromise) {
        trader.autoRecovery?.noteDesiredRunning?.(true, 'control_start');
      }
      return res.json({ message: '자동매매가 실행 중이거나 거래소 상태를 확인하고 있습니다.', success: false });
    }
    try {
      trader.assertLiveValidationGate?.();
      trader.autoRecovery?.noteDesiredRunning?.(true, 'control_start', { requirePersistence: true });
      const start = trader.start();
      Promise.resolve(start).catch(error => {
        console.error('Trading system start error:', error);
      });
      const nextSafety = trader.getRuntimeSafetyStatus?.() || {};
      return res.status(202).json({
        message: nextSafety.runtimeState === 'SYNC_REQUIRED'
          ? '설정한 시장의 계좌와 미체결 주문을 확인한 뒤 시작합니다.'
          : '자동매매 시작을 요청했습니다.',
        success: true,
        starting: true,
        runtimeState: nextSafety.runtimeState || null
      });
    } catch (error) {
      // 게이트 실패 시 최신 검증 리포트를 다시 만들어 다음 시작이 통과할 수 있게 한다.
      trader.liveValidationRefresher?.requestRefresh?.('control_start_gate');
      const failure = describeLiveTradingFailure(error, { fallbackCode: 'trading_start_failed' });
      return res.status(400).json({ error: failure.message, code: failure.code, success: false });
    }
  });

  // 시스템 중지
  router.post('/control/stop', (req, res) => {
    try {
      const trader = server.tradingSystem;
      trader.autoRecovery?.noteDesiredRunning?.(false, 'control_stop');
      if (typeof trader.requestGracefulShutdown === 'function') {
        const shutdown = trader.requestGracefulShutdown('operator_stop');
        Promise.resolve(shutdown).catch(error => {
          console.error('Graceful trading stop error:', error);
        });
        const safety = trader.getRuntimeSafetyStatus?.() || {};
        const hasPositions = (trader.getCurrentPositionCount?.() || 0) > 0;
        const shutdownInProgress = Boolean(trader._gracefulShutdownPromise) ||
          trader._orderInProgress === true || trader._riskCheckInProgress === true;
        const draining = safety.runtimeState === 'PROTECTIVE_ONLY' ||
          safety.runtimeState === 'SYNC_REQUIRED' ||
          safety.exchangeStateKnown === false || hasPositions || shutdownInProgress;
        return res.status(draining ? 202 : 200).json({
          success: true,
          shutdownRequested: true,
          runtimeState: safety.runtimeState || null,
          message: safety.runtimeState === 'PROTECTIVE_ONLY'
            ? '신규 진입을 잠갔습니다. 보유 포지션의 위험 감시를 유지하고 있습니다.'
            : safety.runtimeState === 'SYNC_REQUIRED' || safety.exchangeStateKnown === false
              ? '거래소 계좌와 미체결 주문을 확인할 때까지 중지를 보류합니다.'
              : hasPositions
                ? '신규 진입을 잠그고 보유 포지션 확인을 시작했습니다.'
                : shutdownInProgress
                  ? '진행 중인 주문과 위험 확인을 마친 뒤 중지를 완료합니다.'
                : '자동매매를 중지했습니다.'
        });
      }
      if (trader.isRunning) {
        trader.stop();
        return res.json({ message: '자동매매를 중지했습니다.', success: true });
      }
      return res.json({ message: '자동매매가 실행 중이 아닙니다.', success: false });
    } catch {
      return res.status(500).json({ error: '자동매매를 중지하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  // 설정 업데이트
  router.post('/config/update', async (req, res) => {
    if (respondIfPaperEvidenceMutationBlocked(server.tradingSystem, res, 'config_update')) return;
    try {
      const newConfig = req.body;
      if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
        return res.status(400).json({ error: '설정 값을 확인해 주세요.', success: false });
      }

      // env 수준 유니버스/포지션 키는 일반 범위 검증 대신 전용 경로로 적용한다.
      const universeUpdate = {};
      for (const key of ['targetCoins', 'scalpMaxMarkets', 'maxPositions']) {
        if (newConfig[key] !== undefined) {
          universeUpdate[key] = newConfig[key];
          delete newConfig[key];
        }
      }
      if (universeUpdate.targetCoins !== undefined) {
        const raw = universeUpdate.targetCoins;
        const validList = Array.isArray(raw) && raw.length > 0 && raw.length <= 500 &&
          raw.every(code => typeof code === 'string' && /^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$/.test(code.trim().toUpperCase()));
        if (!(typeof raw === 'string' && raw.trim().toUpperCase() === 'ALL' || validList)) {
          return res.status(400).json({
            error: '분석 대상 코인은 QUOTE-BASE 코드 목록 또는 ALL로 설정해 주세요.',
            success: false
          });
        }
      }
      if (universeUpdate.scalpMaxMarkets !== undefined &&
        (!Number.isInteger(Number(universeUpdate.scalpMaxMarkets)) ||
          Number(universeUpdate.scalpMaxMarkets) < 1 || Number(universeUpdate.scalpMaxMarkets) > 500)) {
        return res.status(400).json({ error: '스캔 마켓 수는 1~500 정수로 설정해 주세요.', success: false });
      }
      if (universeUpdate.maxPositions !== undefined &&
        (!Number.isInteger(Number(universeUpdate.maxPositions)) ||
          Number(universeUpdate.maxPositions) < 1 || Number(universeUpdate.maxPositions) > 50)) {
        return res.status(400).json({ error: '최대 동시 포지션 수는 1~50 정수로 설정해 주세요.', success: false });
      }

      for (const [key, rawValue] of Object.entries(newConfig)) {
        if (BOOLEAN_CONFIGURATION_KEYS.has(key)) {
          if (typeof rawValue !== 'boolean' && rawValue !== 'true' && rawValue !== 'false') {
            return res.status(400).json({ error: `${key} 값을 확인해 주세요.`, success: false });
          }
          newConfig[key] = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue;
          continue;
        }
        const range = CONFIGURATION_RANGES[key];
        if (!range || (typeof rawValue !== 'number' && typeof rawValue !== 'string') || String(rawValue).trim() === '') {
          return res.status(400).json({ error: '지원하지 않는 설정 항목이 포함되어 있습니다.', success: false });
        }
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
          return res.status(400).json({ error: `${key} 값은 ${range[0]}~${range[1]} 범위로 설정해 주세요.`, success: false });
        }
        newConfig[key] = value;
      }

      let investmentRatio;
      if (newConfig.investmentRatio !== undefined) {
        investmentRatio = Number(newConfig.investmentRatio);
        if (!Number.isFinite(investmentRatio) || investmentRatio < 0.01 || investmentRatio > 1) {
          return res.status(400).json({ error: '1회 투자 비율은 1~100% 범위로 설정해 주세요.', success: false });
        }
      }

      if (newConfig.stopLossPercent && (newConfig.stopLossPercent < 0 || newConfig.stopLossPercent > 100)) {
        return res.status(400).json({ error: '손절률은 0~100% 범위에서 설정해 주세요.', success: false });
      }
      const protectedRanges = [
        ['breakEvenTriggerPercent', 0, 5],
        ['breakEvenOffsetPercent', 0, 1],
        ['trailingActivationPercent', 0, 10],
        ['trailingStopPercent', 0, 5],
        ['maxLosingHoldMinutes', 0, 240],
        ['winnerExtendMinutes', 0, 240],
        ['winnerExtendMinProfitPercent', 0, 5],
        ['maxEntriesPerSignalWindow', 0, 20],
        ['marketRegimeLookback', 1, 60],
        ['marketRegimeMinBreadth', 0, 1],
        ['marketRegimeMinReturnPercent', -10, 10],
        ['lossCircuitBreakerCount', 0, 20],
        ['lossCircuitBreakerWindowMinutes', 1, 1440],
        ['lossCircuitBreakerCooldownMinutes', 1, 1440],
        ['maxRiskDataGapSeconds', 5, 600],
        ['maxAnalysisDataGapSeconds', 5, 600],
        ['maxCandleAgeSeconds', 60, 900]
      ];
      const protectedLabels = {
        breakEvenTriggerPercent: '진입가 보호 시작률',
        breakEvenOffsetPercent: '진입가 보호 여유폭',
        trailingActivationPercent: '고점 추적 보호 시작률',
        trailingStopPercent: '고점 대비 허용 하락률',
        maxLosingHoldMinutes: '손실 중인 포지션의 최대 보유 시간',
        winnerExtendMinutes: '수익 중인 포지션의 보유 연장 시간',
        winnerExtendMinProfitPercent: '보유 연장에 필요한 최소 수익률',
        maxEntriesPerSignalWindow: '같은 캔들의 최대 진입 횟수',
        marketRegimeLookback: '시장 방향 비교 기간',
        marketRegimeMinBreadth: '상승 시장 최소 비율',
        marketRegimeMinReturnPercent: '시장 최소 수익률',
        lossCircuitBreakerCount: '손실 차단 기준 횟수',
        lossCircuitBreakerWindowMinutes: '손실 횟수 확인 기간',
        lossCircuitBreakerCooldownMinutes: '손실 차단 후 대기 시간',
        maxRiskDataGapSeconds: '위험 확인 시세 공백 한도',
        maxAnalysisDataGapSeconds: '시장 분석 공백 한도',
        maxCandleAgeSeconds: '최대 캔들 경과 시간'
      };
      for (const [key, min, max] of protectedRanges) {
        if (newConfig[key] === undefined) continue;
        const value = Number(newConfig[key]);
        if (!Number.isFinite(value) || value < min || value > max) {
          return res.status(400).json({ error: `${protectedLabels[key]} 값은 ${min}~${max} 범위로 설정해 주세요.`, success: false });
        }
      }
      if (newConfig.marketRegimeEnabled !== undefined &&
        typeof newConfig.marketRegimeEnabled !== 'boolean' &&
        newConfig.marketRegimeEnabled !== 'true' &&
        newConfig.marketRegimeEnabled !== 'false') {
        return res.status(400).json({ error: '시장 방향 필터 값을 확인해 주세요.', success: false });
      }
      if (newConfig.marketRegimeEnabled === 'true' || newConfig.marketRegimeEnabled === 'false') {
        newConfig.marketRegimeEnabled = newConfig.marketRegimeEnabled === 'true';
      }
      if (newConfig.requireReboundBelowOverbought !== undefined &&
        typeof newConfig.requireReboundBelowOverbought !== 'boolean' &&
        newConfig.requireReboundBelowOverbought !== 'true' &&
        newConfig.requireReboundBelowOverbought !== 'false') {
        return res.status(400).json({ error: '반등 과매수 보호 설정을 확인해 주세요.', success: false });
      }
      if (newConfig.requireReboundBelowOverbought === 'true' || newConfig.requireReboundBelowOverbought === 'false') {
        newConfig.requireReboundBelowOverbought = newConfig.requireReboundBelowOverbought === 'true';
      }

      let universeApplied = null;
      if (Object.keys(universeUpdate).length > 0) {
        if (typeof server.tradingSystem.applyRuntimeMarketUniverse !== 'function') {
          return res.status(400).json({
            error: '이 서버에서는 대상 마켓 변경을 지원하지 않습니다.',
            success: false
          });
        }
        server.tradingSystem.assertRuntimeMarketUniverseUpdateAllowed?.(universeUpdate);
        universeApplied = await server.tradingSystem.applyRuntimeMarketUniverse(universeUpdate);
      }

      const configUpdates = { ...newConfig };
      delete configUpdates.investmentRatio;
      Object.assign(server.tradingSystem.config, configUpdates);
      if (investmentRatio !== undefined) server.tradingSystem.investmentRatio = investmentRatio;

      if (server.tradingSystem.isScalpingMode) {
        const protectedKeys = [
          'breakEvenTriggerPercent',
          'breakEvenOffsetPercent',
          'trailingActivationPercent',
          'trailingStopPercent',
          'maxHoldMinutes',
          'maxLosingHoldMinutes',
          'winnerExtendMinutes',
          'winnerExtendMinProfitPercent',
          'maxEntriesPerSignalWindow',
          'maxRiskDataGapSeconds',
          'maxAnalysisDataGapSeconds',
          'maxCandleAgeSeconds'
        ];
        for (const key of protectedKeys) {
          if (newConfig[key] === undefined) continue;
          if (server.tradingSystem.strategyConfig) {
            server.tradingSystem.strategyConfig[key] = newConfig[key];
          }
          server.tradingSystem[key] = newConfig[key];
          for (const strategy of server.tradingSystem.strategies?.values() || []) {
            if (strategy?.config) strategy.config[key] = newConfig[key];
            strategy[key] = newConfig[key];
            if (key === 'maxHoldMinutes') {
              strategy.maxHoldMs = Math.max(0, Number(newConfig[key]) || 0) * 60 * 1000;
            }
            if (key === 'maxLosingHoldMinutes') {
              strategy.maxLosingHoldMs = Math.max(0, Number(newConfig[key]) || 0) * 60 * 1000;
            }
            if (key === 'winnerExtendMinutes') {
              strategy.winnerExtendMs = Math.max(0, Number(newConfig[key]) || 0) * 60 * 1000;
            }
            if (key === 'winnerExtendMinProfitPercent') {
              strategy.winnerExtendMinProfitPercent = Math.max(0, Number(newConfig[key]) || 0);
            }
          }
          if (key === 'maxCandleAgeSeconds') {
            server.tradingSystem.maxCandleAgeSeconds = resolveMaxCandleAgeSeconds(
              newConfig[key],
              server.tradingSystem.candleUnit
            );
            server.tradingSystem.config.maxCandleAgeSeconds = server.tradingSystem.maxCandleAgeSeconds;
          }
        }
        if (newConfig.maxAnalysisDataGapSeconds !== undefined) {
          server.tradingSystem.maxAnalysisDataGapSeconds = Math.max(5, Number(newConfig.maxAnalysisDataGapSeconds) || 60);
          server.tradingSystem.config.maxAnalysisDataGapSeconds = server.tradingSystem.maxAnalysisDataGapSeconds;
        }
      }


      res.json({
        message: '설정을 저장했습니다.',
        success: true,
        config: server.tradingSystem.config,
        investmentRatio: server.tradingSystem.investmentRatio,
        universe: universeApplied
      });
    } catch (error) {
      if (error?.code === 'live_universe_update_requires_stop' || error?.code === 'runtime_markets_invalid') {
        const failure = describeLiveTradingFailure(error);
        const statusCode = error.code === 'live_universe_update_requires_stop' ? 409 : 400;
        return res.status(statusCode).json({ error: failure.message, code: failure.code, success: false });
      }
      res.status(500).json({ error: '설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.', success: false });
    }
  });

  // API 테스트
  router.get('/test', async (req, res) => {
    try {
      const status = {
        hasUpbit: !!server.tradingSystem.upbit,
        hasStrategies: !!server.tradingSystem.strategies,
        strategiesCount: server.tradingSystem.strategies?.size || 0,
        targetCoins: server.tradingSystem.targetCoins || [],
        isRunning: server.tradingSystem.isRunning,
        dryRun: server.tradingSystem.dryRun
      };

      if (server.tradingSystem.upbit) {
        try {
          const ticker = await getMarketDataProvider(server).getTickers(`${server.tradingSystem.quoteAsset || 'KRW'}-BTC`, {
            freshness: MARKET_DATA_FRESHNESS.FRESH
          });
          status.tickerTest = {
            success: true,
            btcPrice: ticker[0]?.trade_price
          };
        } catch {
          status.tickerTest = {
            success: false,
            error: '시세 연결 상태를 확인하지 못했습니다.'
          };
        }
      }

      res.json(status);
    } catch {
      res.status(500).json({ error: '연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  });

  return router;
}
