import dotenv from 'dotenv';
import UpbitAPI from '../api/upbit.js';
import ParameterOptimizer from '../optimization/parameterOptimizer.js';
import fs from 'fs';
import axios from 'axios';

dotenv.config();

/**
 * 여러 번의 API 호출로 충분한 분봉 데이터 수집
 */
async function getMultipleMinuteCandles(upbit, market, unit, totalCount) {
  const maxPerRequest = 200;
  const allCandles = [];
  let to = null;

  while (allCandles.length < totalCount) {
    const count = Math.min(maxPerRequest, totalCount - allCandles.length);

    try {
      let candles;
      if (to) {
        candles = await upbit.requestWithRetry(async () => {
            const response = await axios.get(
              `https://api.upbit.com/v1/candles/minutes/${unit}`,
              upbit.getRequestConfig({ params: { market, count, to } })
            );
          return response.data;
        });
      } else {
        candles = await upbit.getMinuteCandles(market, unit, count);
      }

      if (!candles || candles.length === 0) break;

      allCandles.push(...candles);
      const oldestCandle = candles[candles.length - 1];
      to = oldestCandle.candle_date_time_utc;

      console.log(`  수집: ${allCandles.length}/${totalCount} 캔들`);
      await sleep(100);
    } catch (error) {
      console.error(`캔들 데이터 수집 오류 (${market}):`, error.message);
      break;
    }
  }

  return allCandles;
}

async function runContinuousOptimization() {
  console.log('\n' + '='.repeat(80));
  console.log('🧬 지속적 파라미터 최적화 시스템');
  console.log('='.repeat(80));

  const upbit = new UpbitAPI(
    process.env.UPBIT_ACCESS_KEY || '',
    process.env.UPBIT_SECRET_KEY || ''
  );

  const targetCoin = process.env.TARGET_COIN || 'KRW-BTC';
  const candleUnit = parseInt(process.env.BACKTEST_CANDLE_UNIT) || 15;
  const candleCount = parseInt(process.env.BACKTEST_CANDLE_COUNT) || 500;
  const isDryRun = process.env.DRY_RUN !== 'false';

  // 드라이 모드일 때 더 짧은 간격 (6시간), 실전은 24시간
  const interval = isDryRun
    ? parseInt(process.env.OPTIMIZATION_INTERVAL_DRY) || 21600000  // 6시간
    : parseInt(process.env.OPTIMIZATION_INTERVAL) || 86400000;      // 24시간

  console.log(`\n⚙️  설정:`);
  console.log(`  모드: ${isDryRun ? '🧪 모의투자' : '💰 실전투자'}`);
  console.log(`  타겟 코인: ${targetCoin}`);
  console.log(`  캔들: ${candleUnit}분봉, ${candleCount}개`);
  console.log(`  최적화 간격: ${interval / 3600000}시간`);
  console.log(`  개체군 크기: ${process.env.POPULATION_SIZE || 20}`);
  console.log(`  세대 수: ${process.env.GENERATIONS || 10}`);

  if (isDryRun) {
    console.log(`\n💡 드라이 모드: 더 짧은 간격(${interval / 3600000}시간)으로 최적화`);
  }

  const optimizer = new ParameterOptimizer({
    populationSize: parseInt(process.env.POPULATION_SIZE) || 20,
    generations: parseInt(process.env.GENERATIONS) || 10,
    mutationRate: parseFloat(process.env.MUTATION_RATE) || 0.2,
    crossoverRate: parseFloat(process.env.CROSSOVER_RATE) || 0.7,
    eliteSize: parseInt(process.env.ELITE_SIZE) || 2
  });

  let cycleCount = 0;

  // 종료 핸들러
  const gracefulShutdown = () => {
    console.log('\n\n⏹️  최적화 시스템 종료 중...');
    console.log(`총 ${cycleCount}회 최적화 완료`);
    console.log('\n👋 프로그램을 종료합니다.\n');
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  console.log('\n💡 팁:');
  console.log('  - Ctrl+C를 눌러 언제든지 종료할 수 있습니다.');
  console.log('  - 최적 파라미터는 optimal_config.json에 자동 저장됩니다.');
  console.log('  - 로그는 logs/ 디렉토리에 저장됩니다.\n');
  console.log('─'.repeat(80));

  while (true) {
    try {
      cycleCount++;
      const now = new Date();
      console.log(`\n\n⏰ [${now.toLocaleString('ko-KR')}] 최적화 사이클 #${cycleCount} 시작`);
      console.log('='.repeat(80));

      // 분봉 데이터 가져오기
      console.log('\n📊 분봉 데이터 수집 중...');
      const candles = await getMultipleMinuteCandles(upbit, targetCoin, candleUnit, candleCount);
      console.log(`✅ 데이터 수집 완료: ${candles.length}개 ${candleUnit}분봉`);

      if (candles.length < 250) {
        console.log('⚠️  데이터 부족, 다음 사이클 대기...');
        await sleep(interval);
        continue;
      }

      // 최적화 실행
      const optimizationResult = await optimizer.optimize(candles);
      const optimalParams = optimizationResult.parameters;
      const fitness = optimizationResult.fitness;

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
      console.log('─'.repeat(80));

      // 결과 저장
      const config = {
        updatedAt: new Date().toISOString(),
        cycle: cycleCount,
        targetCoin,
        candleUnit,
        candleCount: candles.length,
        fitness: fitness,
        parameters: optimalParams,
        note: '지속적 최적화를 통해 생성된 파라미터입니다.'
      };

      fs.writeFileSync(
        'optimal_config.json',
        JSON.stringify(config, null, 2),
        'utf8'
      );

      console.log('\n💾 최적 파라미터 저장: optimal_config.json');

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
      const historyFile = 'optimization_history.json';
      let history = [];

      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      }

      history.push({
        timestamp: new Date().toISOString(),
        cycle: cycleCount,
        fitness: fitness,
        parameters: optimalParams
      });

      // 최근 100개만 유지
      if (history.length > 100) {
        history = history.slice(-100);
      }

      fs.writeFileSync(
        historyFile,
        JSON.stringify(history, null, 2),
        'utf8'
      );

      console.log('📝 최적화 이력 저장: optimization_history.json');

      // 다음 사이클까지 대기
      const nextRun = new Date(Date.now() + interval);
      console.log(`\n⏳ 다음 최적화: ${nextRun.toLocaleString('ko-KR')} (${interval / 3600000}시간 후)`);
      console.log('─'.repeat(80));

      await sleep(interval);

    } catch (error) {
      console.error('\n❌ 최적화 오류:', error.message);
      console.log('⏳ 10분 후 재시도...');
      await sleep(600000); // 10분 대기
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runContinuousOptimization().catch(error => {
  console.error('치명적 오류:', error);
  process.exit(1);
});
