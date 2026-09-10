import express from 'express';
import { resolveMaxCandleAgeSeconds } from '../../risk/candleFreshness.js';

/**
 * 설정/제어 관련 라우트
 */
export default function createConfigRoutes(server) {
  const router = express.Router();

  // 파라미터 범위 조회
  router.get('/parameter-ranges', (req, res) => {
    res.json({
      investmentRatio: { min: 0.01, max: 1.0, step: 0.01, label: '투자 비율 (%)', description: '총 자산 대비 1회 투자 비율 (1%~100%)', category: 'Investment', displayMultiplier: 100 },
      rsiPeriod: { min: 2, max: 100, step: 1, label: 'RSI 기간', description: 'RSI 계산에 사용할 기간 (2~100)', category: 'RSI' },
      rsiOversold: { min: 1, max: 50, step: 1, label: 'RSI 과매도', description: '과매도 판단 기준값 (1~50)', category: 'RSI' },
      oversoldLookback: { min: 1, max: 10, step: 1, label: '과매도 탐색 범위', description: '최근 완료 봉 중 과매도 상태를 찾을 최대 범위 (기본 1; 후보 3)', category: 'Scalping' },
      rsiOverbought: { min: 50, max: 99, step: 1, label: 'RSI 과매수', description: '과매수 판단 기준값 (50~99)', category: 'RSI' },
      macdFast: { min: 1, max: 100, step: 1, label: 'MACD Fast', description: 'MACD 빠른 이동평균 기간 (1~100)', category: 'MACD' },
      macdSlow: { min: 2, max: 200, step: 1, label: 'MACD Slow', description: 'MACD 느린 이동평균 기간 (2~200)', category: 'MACD' },
      macdSignal: { min: 1, max: 100, step: 1, label: 'MACD Signal', description: 'MACD 신호선 기간 (1~100)', category: 'MACD' },
      bbPeriod: { min: 2, max: 200, step: 1, label: 'BB 기간', description: '볼린저 밴드 이동평균 기간 (2~200)', category: 'Bollinger' },
      bbStdDev: { min: 0.1, max: 10, step: 0.1, label: 'BB 표준편차', description: '볼린저 밴드 표준편차 배수 (0.1~10)', category: 'Bollinger' },
      emaShort: { min: 1, max: 100, step: 1, label: 'EMA 단기', description: '단기 지수이동평균 기간 (1~100)', category: 'EMA' },
      emaMid: { min: 2, max: 200, step: 1, label: 'EMA 중기', description: '중기 지수이동평균 기간 (2~200)', category: 'EMA' },
      emaLong: { min: 3, max: 500, step: 1, label: 'EMA 장기', description: '장기 지수이동평균 기간 (3~500)', category: 'EMA' },
      stopLossPercent: { min: 0.1, max: 100, step: 0.1, label: '손절률 (%)', description: '손절 실행 기준 하락률 (0.1%~100%)', category: 'Trading' },
      takeProfitPercent: { min: 0.1, max: 1000, step: 0.1, label: '익절률 (%)', description: '익절 실행 기준 상승률 (0.1%~1000%)', category: 'Trading' },
      trailingStopPercent: { min: 0, max: 50, step: 0.05, label: '트레일링 스탑 (%)', description: '스캘핑은 0으로 비활성화; 활성화 시 고점 대비 하락폭', category: 'Trading' },
      minReboundPercent: { min: 0.01, max: 5, step: 0.01, label: '최소 반등률 (%)', description: '과매도 이후 완료 캔들의 최소 반등률', category: 'Scalping' },
      minRsiRecovery: { min: 0.1, max: 30, step: 0.1, label: '최소 RSI 회복', description: '직전 완료 캔들 대비 RSI 회복 폭', category: 'Scalping' },
      minVolumeRatio: { min: 0, max: 10, step: 0.1, label: '최소 거래량 배수', description: '반등 캔들의 과거 평균 대비 최소 거래량', category: 'Scalping' },
      minCloseStrength: { min: 0, max: 1, step: 0.05, label: '종가 강도', description: '캔들 범위 내 종가 위치 최소 비율', category: 'Scalping' },
      trendPeriod: { min: 5, max: 240, step: 1, label: '추세 기간', description: '반등 전 추세 필터에 사용할 완료 캔들 수', category: 'Scalping' },
      trendSlopeLookback: { min: 1, max: 30, step: 1, label: '추세 기울기 비교', description: '추세 평균을 비교할 과거 간격', category: 'Scalping' },
      minTrendSlopePercent: { min: -10, max: 10, step: 0.1, label: '최소 추세 기울기 (%)', description: '강한 하락 추세에서 진입하지 않기 위한 하한', category: 'Scalping' },
      maxSignalRangePercent: { min: 0, max: 10, step: 0.1, label: '신호 캔들 변동폭 상한 (%)', description: '급변 캔들 진입을 제한하는 고가-저가 범위 상한 (0은 비활성)', category: 'Scalping' },
      minSignalRangePercent: { min: 0, max: 10, step: 0.1, label: '신호 캔들 변동폭 하한 (%)', description: '조용한 반등을 제한하는 고가-저가 범위 하한 (0은 비활성)', category: 'Scalping' },
      marketRegimeLookback: { min: 1, max: 60, step: 1, label: '시장 regime 비교 봉', description: '전체 대상 마켓의 단기 방향성을 비교할 완료 캔들 간격', category: 'Scalping' },
      marketRegimeMinBreadth: { min: 0, max: 1, step: 0.05, label: '시장 상승 breadth', description: '시장 regime gate가 요구하는 최소 상승 마켓 비율 (0~1)', category: 'Risk' },
      marketRegimeMinReturnPercent: { min: -10, max: 10, step: 0.1, label: '시장 최소 수익률 (%)', description: 'regime breadth에 포함할 마켓의 lookback 수익률 하한', category: 'Risk' },
      positionRiskCheckIntervalMs: { min: 250, max: 10000, step: 250, label: '포지션 리스크 확인 주기 (ms)', description: '열린 포지션의 손절·익절·최대보유시간을 독립 확인하는 주기', category: 'Risk' },
      maxRiskDataGapSeconds: { min: 5, max: 600, step: 5, label: '리스크 시세 공백 한도 (초)', description: '열린 포지션의 ticker 확인이 이 시간보다 끊기면 paper/live 매매를 fail-closed로 중지합니다', category: 'Risk' },
      maxCandleAgeSeconds: { min: 60, max: 900, step: 30, label: '최대 캔들 신선도 (초)', description: '진입 시 최신 캔들 시각이 이보다 오래되면 안전하게 진입을 차단합니다 (1분봉 기본 90초)', category: 'Risk' },
      entryDelayMinMs: { min: 1000, max: 5000, step: 100, label: '최소 진입 지연 (ms)', description: '반등 확인 후 최소 재검증 대기 시간', category: 'Scalping' },
      entryDelayMaxMs: { min: 1000, max: 5000, step: 100, label: '최대 진입 지연 (ms)', description: '반등 확인 후 최대 재검증 대기 시간', category: 'Scalping' },
      maxEntryRetracePercent: { min: 0.01, max: 5, step: 0.01, label: '허용 되밀림 (%)', description: '지연 중 허용되는 반등 되밀림', category: 'Scalping' },
      maxEntryChasePercent: { min: 0.01, max: 5, step: 0.01, label: '허용 추격 (%)', description: '지연 중 반등을 추격하지 않도록 제한하는 상승폭', category: 'Scalping' },
      breakEvenTriggerPercent: { min: 0, max: 5, step: 0.05, label: 'Break-even 발동 (%)', description: '0은 비활성화; 이익 도달 뒤 진입가 보호 출구를 켬', category: 'Risk' },
      breakEvenOffsetPercent: { min: 0, max: 1, step: 0.01, label: 'Break-even 여유 (%)', description: '진입가보다 위에 둘 보호 출구 여유폭', category: 'Risk' },
      trailingActivationPercent: { min: 0, max: 10, step: 0.05, label: 'Trailing 발동 (%)', description: '0은 비활성화; 수익이 이 값에 도달하면 trailing 출구를 켬', category: 'Risk' },
      maxHoldMinutes: { min: 1, max: 240, step: 1, label: '최대 보유 시간 (분)', description: '스캘핑 포지션의 최대 보유 시간', category: 'Scalping' },
      maxLosingHoldMinutes: { min: 0, max: 240, step: 1, label: '손실 포지션 조기 청산 (분)', description: '0은 비활성화; 이 시간 뒤에도 손실 중인 포지션만 먼저 청산', category: 'Risk' },
      maxEntriesPerSignalWindow: { min: 0, max: 20, step: 1, label: '동일 신호창 최대 진입', description: '동일 완료 캔들 signal window의 전역 동시 진입 상한 (0은 비활성)', category: 'Risk' },
      lossCircuitBreakerCount: { min: 0, max: 20, step: 1, label: '전역 손실 차단 횟수', description: '최근 시간창 안에 이 횟수만큼 손실이 나면 모든 신규 진입을 차단 (0은 비활성)', category: 'Risk' },
      lossCircuitBreakerWindowMinutes: { min: 1, max: 1440, step: 1, label: '전역 손실 시간창 (분)', description: '손실 횟수를 누적할 최근 시간 범위', category: 'Risk' },
      lossCircuitBreakerCooldownMinutes: { min: 1, max: 1440, step: 1, label: '전역 손실 차단 시간 (분)', description: '회로차단 발동 후 신규 진입을 막는 시간', category: 'Risk' },
      buyThreshold: { min: 0, max: 100, step: 1, label: '매수 임계값', description: '매수 신호 판단 기준 점수 (0~100)', category: 'Trading' },
      sellThreshold: { min: 0, max: 100, step: 1, label: '매도 임계값', description: '매도 신호 판단 기준 점수 (0~100)', category: 'Trading' },
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
          description: '높은 수익을 목표로 공격적인 매매. 리스크가 높지만 수익 기회도 많음',
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
          description: '안정적인 수익을 목표로 신중한 매매. 리스크가 낮고 안정적',
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
          description: '몇 시간~며칠 단위의 단기 매매. 빠른 수익 실현을 목표',
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
          description: '분 단위의 초단기 매매. 작은 수익을 자주 실현',
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
          description: '몇 주~몇 달 단위의 장기 투자. 큰 추세를 따라 안정적인 수익 추구',
          icon: '🏦',
          riskLevel: 2,
          config: {
            rsiPeriod: 28, rsiOversold: 20, rsiOverbought: 80,
            macdFast: 19, macdSlow: 39, macdSignal: 14,
            bbPeriod: 30, bbStdDev: 2.2,
            emaShort: 20, emaMid: 60, emaLong: 200,
            stopLossPercent: 12, takeProfitPercent: 25, trailingStopPercent: 8,
            buyThreshold: 65, sellThreshold: 65,
            volumeMultiplier: 1.3, volumePeriod: 40,
            investmentRatio: 0.05
          }
        },
        {
          id: 'balanced',
          name: '균형 투자',
          nameEn: 'Balanced',
          description: '공격과 방어의 균형. 적당한 리스크로 안정적인 수익 추구',
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
    try {
      const { presetId, config } = req.body;

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
        for (const [coin, strategy] of server.tradingSystem.strategies.entries()) {
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
      }

      res.json({
        success: true,
        message: `투자 프리셋 '${presetId}'이(가) 적용되었습니다`,
        appliedConfig: config
      });
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 현재 투자 설정 조회
  router.get('/investment-config', (req, res) => {
    try {
      res.json({
        investmentRatio: server.tradingSystem.investmentRatio ?? 0.05,
        initialSeedMoney: server.tradingSystem.initialSeedMoney ?? 0,
        strategyMode: server.tradingSystem.strategyMode,
        scalping: server.tradingSystem.isScalpingMode ? {
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
          maxEntriesPerSignalWindow: server.tradingSystem.config?.maxEntriesPerSignalWindow ?? 0,
          maxCandleAgeSeconds: server.tradingSystem.maxCandleAgeSeconds,
          oversoldLookback: server.tradingSystem.config?.oversoldLookback,
          maxSignalRangePercent: server.tradingSystem.config?.maxSignalRangePercent,
          minSignalRangePercent: server.tradingSystem.config?.minSignalRangePercent,
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
          maxPositions: server.tradingSystem.maxPositions
        } : null,
        minOrderAmount: 5000
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 투자 설정 업데이트
  router.post('/investment-config/update', (req, res) => {
    try {
      const updates = req.body;

      if (updates.investmentRatio !== undefined) {
        server.tradingSystem.investmentRatio = Math.max(0.01, Math.min(1.0, parseFloat(updates.investmentRatio)));
      }

      res.json({
        success: true,
        message: '투자 비율이 업데이트되었습니다',
        config: {
          investmentRatio: server.tradingSystem.investmentRatio,
          minOrderAmount: 5000
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 시스템 시작
  router.post('/control/start', (req, res) => {
    try {
      if (!server.tradingSystem.isRunning) {
        server.tradingSystem.start().catch(error => {
          console.error('Trading system start error:', error);
        });
        res.json({ message: 'Trading system started', success: true });
      } else {
        res.json({ message: 'Trading system already running', success: false });
      }
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 시스템 중지
  router.post('/control/stop', (req, res) => {
    try {
      if (server.tradingSystem.isRunning) {
        server.tradingSystem.stop();
        res.json({ message: 'Trading system stopped', success: true });
      } else {
        res.json({ message: 'Trading system not running', success: false });
      }
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // 설정 업데이트
  router.post('/config/update', (req, res) => {
    try {
      const newConfig = req.body;

      if (newConfig.stopLossPercent && (newConfig.stopLossPercent < 0 || newConfig.stopLossPercent > 100)) {
        return res.status(400).json({ error: 'Invalid stopLossPercent', success: false });
      }
      const protectedRanges = [
        ['breakEvenTriggerPercent', 0, 5],
        ['breakEvenOffsetPercent', 0, 1],
        ['trailingActivationPercent', 0, 10],
        ['trailingStopPercent', 0, 5],
        ['maxLosingHoldMinutes', 0, 240],
        ['maxEntriesPerSignalWindow', 0, 20],
        ['marketRegimeLookback', 1, 60],
        ['marketRegimeMinBreadth', 0, 1],
        ['marketRegimeMinReturnPercent', -10, 10],
        ['lossCircuitBreakerCount', 0, 20],
        ['lossCircuitBreakerWindowMinutes', 1, 1440],
        ['lossCircuitBreakerCooldownMinutes', 1, 1440],
        ['maxRiskDataGapSeconds', 5, 600],
        ['maxCandleAgeSeconds', 60, 900]
      ];
      for (const [key, min, max] of protectedRanges) {
        if (newConfig[key] === undefined) continue;
        const value = Number(newConfig[key]);
        if (!Number.isFinite(value) || value < min || value > max) {
          return res.status(400).json({ error: `Invalid ${key}`, success: false });
        }
      }
      if (newConfig.marketRegimeEnabled !== undefined &&
        typeof newConfig.marketRegimeEnabled !== 'boolean' &&
        newConfig.marketRegimeEnabled !== 'true' &&
        newConfig.marketRegimeEnabled !== 'false') {
        return res.status(400).json({ error: 'Invalid marketRegimeEnabled', success: false });
      }
      if (newConfig.marketRegimeEnabled === 'true' || newConfig.marketRegimeEnabled === 'false') {
        newConfig.marketRegimeEnabled = newConfig.marketRegimeEnabled === 'true';
      }
      if (newConfig.requireReboundBelowOverbought !== undefined &&
        typeof newConfig.requireReboundBelowOverbought !== 'boolean' &&
        newConfig.requireReboundBelowOverbought !== 'true' &&
        newConfig.requireReboundBelowOverbought !== 'false') {
        return res.status(400).json({ error: 'Invalid requireReboundBelowOverbought', success: false });
      }
      if (newConfig.requireReboundBelowOverbought === 'true' || newConfig.requireReboundBelowOverbought === 'false') {
        newConfig.requireReboundBelowOverbought = newConfig.requireReboundBelowOverbought === 'true';
      }

      Object.assign(server.tradingSystem.config, newConfig);

      if (server.tradingSystem.isScalpingMode) {
        const protectedKeys = [
          'breakEvenTriggerPercent',
          'breakEvenOffsetPercent',
          'trailingActivationPercent',
          'trailingStopPercent',
          'maxHoldMinutes',
          'maxLosingHoldMinutes',
          'maxEntriesPerSignalWindow',
          'maxRiskDataGapSeconds',
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
          }
          if (key === 'maxCandleAgeSeconds') {
            server.tradingSystem.maxCandleAgeSeconds = resolveMaxCandleAgeSeconds(
              newConfig[key],
              server.tradingSystem.candleUnit
            );
            server.tradingSystem.config.maxCandleAgeSeconds = server.tradingSystem.maxCandleAgeSeconds;
          }
        }
      }

      res.json({ message: 'Configuration updated', success: true, config: server.tradingSystem.config });
    } catch (error) {
      res.status(500).json({ error: error.message, success: false });
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
          const ticker = await server.tradingSystem.upbit.getTicker('KRW-BTC');
          status.tickerTest = {
            success: true,
            btcPrice: ticker[0]?.trade_price
          };
        } catch (tickerError) {
          status.tickerTest = {
            success: false,
            error: tickerError.message
          };
        }
      }

      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
