// 연구 루프 — 정기 백테스트와 파라미터 최적화 스케줄러.
// index.js의 부팅 코드에서 분리; config/env는 이미 resolve된 값만 받는다.
import fs from 'fs';
import BacktestEngine from '../backtest/backtestEngine.js';
import ParameterOptimizer from '../optimization/parameterOptimizer.js';
import { createExchangeClient } from '../exchange/exchangeFactory.js';
import { resolveOptimizationStoragePaths } from './optimizationStorage.js';
import { appendOptimizerHistory, writeOptimizerJsonAtomically } from './optimizerHistoryStore.js';
import { fetchCompleteUpbitCandleHistory } from '../market-data/completeUpbitCandleHistory.js';
import { envInt, envNumber } from '../config/envConfig.js';

/**
 * 여러 번의 API 호출로 충분한 분봉 데이터 수집
 * @param {UpbitAPI} upbit - Upbit API 인스턴스
 * @param {string} market - 마켓 코드
 * @param {number} unit - 분봉 단위 (1, 3, 5, 15, 30, 60, 240)
 * @param {number} totalCount - 총 수집할 캔들 수
 * @returns {Array} 캔들 데이터 배열 (최신순)
 */
async function getMultipleMinuteCandles(upbit, market, unit, totalCount) {
  return fetchCompleteUpbitCandleHistory({
    marketDataClient: upbit,
    market,
    intervalMinutes: unit,
    totalCount,
    requestSpacingMs: 2_000
  });
}

export function startBacktestingLoop(config, logger, trader) {
  const upbit = createExchangeClient(config);

  const runBacktest = async () => {
    try {
      // 현재 보유 중인 코인만 백테스팅
      const heldCoins = trader.getHeldCoins ? await trader.getHeldCoins() : [];

      if (heldCoins.length === 0) {
        console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 백테스팅 스킵 - 보유 코인 없음`);
        return;
      }

      console.log('\n' + '='.repeat(80));
      console.log(`⏰ [${new Date().toLocaleString('ko-KR')}] 정기 백테스팅 시작 (보유 코인 ${heldCoins.length}개)`);
      console.log('='.repeat(80));

      for (const coin of heldCoins) {
        try {
          console.log(`\n📊 ${coin} 백테스팅...`);

          // 분봉 데이터 수집 (15분봉, 500개)
          const candleUnit = envInt('BACKTEST_CANDLE_UNIT') || 15;
          const candleCount = envInt('BACKTEST_CANDLE_COUNT') || 500;
          const candles = await getMultipleMinuteCandles(upbit, coin, candleUnit, candleCount);

          if (candles.length < 250) {
            console.log(`  ⚠️ ${coin}: 캔들 데이터 부족 (${candles.length}개)`);
            continue;
          }

          const backtest = new BacktestEngine({
            initialBalance: config.dryRunSeedMoney / config.targetCoins.length,
            tradingFee: 0.0005,
            slippage: 0.001
          });

          // 백테스팅용 파라미터 (뉴스 없이 기술적 분석 위주)
          const currentParams = {
            rsiPeriod: envInt('RSI_PERIOD') || config.rsiPeriod,
            rsiOversold: envInt('RSI_OVERSOLD') || config.rsiOversold,
            rsiOverbought: envInt('RSI_OVERBOUGHT') || config.rsiOverbought,
            stopLossPercent: envNumber('STOP_LOSS_PERCENT') || config.stopLossPercent,
            takeProfitPercent: envNumber('TAKE_PROFIT_PERCENT') || config.takeProfitPercent,
            investmentAmount: config.investmentAmount,
            // 백테스팅 전용: 뉴스 없이 기술적 분석 중심
            technicalWeight: 0.9,
            newsWeight: 0.1,
            buyThreshold: 55,
            sellThreshold: 55
          };

          const result = await backtest.run(candles, currentParams);

          console.log(`\n[${coin}] 백테스팅 결과:`);
          console.log(`  수익률: ${result.totalReturnPercent.toFixed(2)}%`);
          console.log(`  승률: ${result.winRate.toFixed(2)}%`);
          console.log(`  총 거래: ${result.totalTrades}회`);
          console.log(`  최대 낙폭: ${result.maxDrawdown.toFixed(2)}%`);
          console.log(`  샤프 비율: ${result.sharpeRatio.toFixed(2)}`);

          // 결과 저장
          const resultsFile = `backtest_results_${coin.replace('-', '_')}.json`;
          fs.writeFileSync(resultsFile, JSON.stringify(result, null, 2), 'utf8');

          // 경고 메시지
          if (result.totalReturnPercent < 0) {
            console.log(`  ⚠️  ${coin}: 현재 전략으로 손실이 예상됩니다!`);
          }

          if (result.maxDrawdown > 30) {
            console.log(`  ⚠️  ${coin}: 최대 낙폭이 30%를 초과합니다!`);
          }

        } catch (error) {
          console.error(`  ❌ ${coin} 백테스팅 오류:`, error.message);
        }
      }

      console.log('\n' + '='.repeat(80));
      console.log('✅ 정기 백테스팅 완료');
      console.log(`⏳ 다음 백테스팅: ${new Date(Date.now() + config.backtestInterval).toLocaleString('ko-KR')}`);
      console.log('='.repeat(80));

    } catch (error) {
      console.error('백테스팅 루프 오류:', error.message);
      logger.error('Backtest Loop Error', { error: error.message });
    }
  };

  // 즉시 한 번 실행
  setTimeout(runBacktest, 60000); // 1분 후 첫 실행

  // 주기적 실행
  return setInterval(runBacktest, config.backtestInterval);
}

export function startOptimizationLoop(config, logger) {
  const upbit = createExchangeClient(config);
  const optimizationStoragePaths = resolveOptimizationStoragePaths({
    env: process.env,
    stateDir: config.stateDir,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    legacyBase: 'cwd'
  });

  // 드라이 모드일 때 더 짧은 간격 (6시간), 실전은 24시간
  const interval = config.dryRun
    ? envInt('OPTIMIZATION_INTERVAL_DRY') || 21600000  // 6시간
    : envInt('OPTIMIZATION_INTERVAL') || 86400000;      // 24시간

  const optimizer = new ParameterOptimizer({
    populationSize: envInt('POPULATION_SIZE') || 20,
    generations: envInt('GENERATIONS') || 10,
    mutationRate: envNumber('MUTATION_RATE') || 0.2,
    crossoverRate: envNumber('CROSSOVER_RATE') || 0.7,
    eliteSize: envInt('ELITE_SIZE') || 2,
    optimalConfigFile: optimizationStoragePaths.optimalConfigFile.absolutePath,
    optimizationHistoryFile: optimizationStoragePaths.optimizationHistoryFile.absolutePath
  });

  let cycleCount = 0;

  const runOptimization = async () => {
    try {
      cycleCount++;
      const now = new Date();
      console.log(`\n\n⏰ [${now.toLocaleString('ko-KR')}] 최적화 사이클 #${cycleCount} 시작`);
      console.log('='.repeat(80));

      // 대표 코인으로 최적화 (첫 번째 코인 사용)
      const targetCoin = config.targetCoins[0];
      const candleUnit = envInt('BACKTEST_CANDLE_UNIT') || 15;
      const candleCount = envInt('BACKTEST_CANDLE_COUNT') || 500;

      console.log('\n📊 분봉 데이터 수집 중...');
      const candles = await getMultipleMinuteCandles(upbit, targetCoin, candleUnit, candleCount);
      console.log(`✅ 데이터 수집 완료: ${candles.length}개 ${candleUnit}분봉`);

      if (candles.length < 250) {
        console.log('⚠️  데이터 부족, 다음 사이클 대기...');
        return;
      }

      // 최적화 실행
      const optimResult = await optimizer.optimize(candles);
      // optimizer.optimize()는 { parameters, fitness, generation } 반환
      const optimalParams = optimResult.parameters;
      const optimalFitness = optimResult.fitness;

      // 결과 출력
      console.log('\n' + '='.repeat(80));
      console.log('✨ 최적화 완료!');
      console.log('='.repeat(80));
      console.log('\n📋 최적 파라미터:');
      console.log('─'.repeat(80));
      console.log(`RSI_PERIOD=${optimalParams.rsiPeriod}`);
      console.log(`RSI_OVERSOLD=${optimalParams.rsiOversold}`);
      console.log(`RSI_OVERBOUGHT=${optimalParams.rsiOverbought}`);
      console.log(`MACD_FAST=${optimalParams.macdFast}`);
      console.log(`MACD_SLOW=${optimalParams.macdSlow}`);
      console.log(`MACD_SIGNAL=${optimalParams.macdSignal}`);
      console.log(`STOP_LOSS_PERCENT=${optimalParams.stopLossPercent}`);
      console.log(`TAKE_PROFIT_PERCENT=${optimalParams.takeProfitPercent}`);
      console.log(`BUY_THRESHOLD=${optimalParams.buyThreshold}`);
      console.log(`SELL_THRESHOLD=${optimalParams.sellThreshold}`);
      console.log(`예상 수익률: ${optimalFitness?.toFixed(2)}%`);
      console.log('─'.repeat(80));

      // 결과 저장
      // 학습 일수 계산 (분봉 개수 * 분봉 단위 / 분당 일수)
      const trainingDays = Math.round((candles.length * candleUnit) / (60 * 24));
      const optimConfig = {
        updatedAt: new Date().toISOString(),
        cycle: cycleCount,
        targetCoin,
        trainingDays: trainingDays,
        candleCount: candles.length,
        fitness: optimalFitness,
        parameters: optimalParams,
        note: '지속적 최적화를 통해 생성된 파라미터입니다.'
      };

      await writeOptimizerJsonAtomically(
        optimizationStoragePaths.optimalConfigFile.absolutePath,
        optimConfig
      );

      console.log(`\n💾 최적 파라미터 저장: ${optimizationStoragePaths.optimalConfigFile.absolutePath}`);

      // 런타임 환경변수 업데이트
      console.log('\n🔄 런타임 환경변수 자동 업데이트 중...');
      process.env.RSI_PERIOD = String(optimalParams.rsiPeriod);
      process.env.RSI_OVERSOLD = String(optimalParams.rsiOversold);
      process.env.RSI_OVERBOUGHT = String(optimalParams.rsiOverbought);
      process.env.MACD_FAST = String(optimalParams.macdFast);
      process.env.MACD_SLOW = String(optimalParams.macdSlow);
      process.env.MACD_SIGNAL = String(optimalParams.macdSignal);
      process.env.STOP_LOSS_PERCENT = String(optimalParams.stopLossPercent);
      process.env.TAKE_PROFIT_PERCENT = String(optimalParams.takeProfitPercent);
      process.env.BUY_THRESHOLD = String(optimalParams.buyThreshold);
      process.env.SELL_THRESHOLD = String(optimalParams.sellThreshold);
      console.log('✅ 런타임 환경변수 업데이트 완료');

      // 최적화 이력 로그
      const historyFile = optimizationStoragePaths.optimizationHistoryFile.absolutePath;
      await appendOptimizerHistory(historyFile, {
        timestamp: new Date().toISOString(),
        cycle: cycleCount,
        fitness: optimalFitness,
        parameters: optimalParams
      });

      console.log(`📝 최적화 이력 저장: ${historyFile}`);

      // 다음 사이클까지 대기
      const nextRun = new Date(Date.now() + interval);
      console.log(`\n⏳ 다음 최적화: ${nextRun.toLocaleString('ko-KR')} (${interval / 3600000}시간 후)`);
      console.log('─'.repeat(80));

    } catch (error) {
      console.error('\n❌ 최적화 오류:', error.message);
      logger.error('Optimization Loop Error', { error: error.message });
    }
  };

  // 2분 후 첫 실행
  setTimeout(runOptimization, 120000);

  // 주기적 실행
  return setInterval(runOptimization, interval);
}
