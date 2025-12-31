import express from 'express';

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
      trailingStopPercent: { min: 0.1, max: 50, step: 0.1, label: '트레일링 스탑 (%)', description: '고점 대비 하락 시 매도 (0.1%~50%)', category: 'Trading' },
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
            stopLossPercent: 1.5, takeProfitPercent: 2.5, trailingStopPercent: 1,
            buyThreshold: 45, sellThreshold: 45,
            volumeMultiplier: 2.5, volumePeriod: 5,
            investmentRatio: 0.20
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
        volumePeriod: config.volumePeriod
      });

      if (server.tradingSystem.strategyConfig) {
        Object.assign(server.tradingSystem.strategyConfig, {
          stopLossPercent: config.stopLossPercent,
          takeProfitPercent: config.takeProfitPercent,
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

      Object.assign(server.tradingSystem.config, newConfig);

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
