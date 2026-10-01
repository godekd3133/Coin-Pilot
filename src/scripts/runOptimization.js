import dotenv from 'dotenv';
import UpbitAPI from '../api/upbit.js';
import ParameterOptimizer from '../optimization/parameterOptimizer.js';
import { fetchCompleteUpbitCandleHistory } from '../market-data/completeUpbitCandleHistory.js';
import { resolveOptimizationStoragePaths } from '../runtime/optimizationStorage.js';
import { appendOptimizerHistory, writeOptimizerJsonAtomically } from '../runtime/optimizerHistoryStore.js';
import { pathToFileURL } from 'node:url';
import { envBool, envNumber, envRaw, envString } from '../config/envConfig.js';

dotenv.config();

/**
 * 여러 번의 API 호출로 충분한 분봉 데이터 수집
 */
export async function getMultipleMinuteCandles(upbit, market, unit, totalCount, maxPerRequest = 200) {
  return fetchCompleteUpbitCandleHistory({
    marketDataClient: upbit,
    market,
    intervalMinutes: unit,
    totalCount,
    maxPerRequest,
    requestSpacingMs: 100,
    sleepImpl: milliseconds => sleep(milliseconds)
  });
}

async function runContinuousOptimization() {
  console.log('\n' + '='.repeat(80));
  console.log('🧬 지속적 파라미터 최적화 시스템');
  console.log('='.repeat(80));

  const upbit = new UpbitAPI(
    envString('UPBIT_ACCESS_KEY', ''),
    envString('UPBIT_SECRET_KEY', '')
  );

  const targetCoin = envString('TARGET_COIN', 'KRW-BTC');
  const candleUnit = envNumber('BACKTEST_CANDLE_UNIT', NaN) || 15;
  const candleCount = envNumber('BACKTEST_CANDLE_COUNT', NaN) || 500;
  const optimizationStoragePaths = resolveOptimizationStoragePaths({
    env: process.env,
    stateDir: envRaw('COINPILOT_STATE_DIR'),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    legacyBase: 'cwd'
  });
  const isDryRun = envBool('DRY_RUN', true);

  // 드라이 모드일 때 더 짧은 간격 (6시간), 실전은 24시간
  const interval = isDryRun
    ? envNumber('OPTIMIZATION_INTERVAL_DRY', NaN) || 21600000  // 6시간
    : envNumber('OPTIMIZATION_INTERVAL', NaN) || 86400000;      // 24시간

  console.log(`\n⚙️  설정:`);
  console.log(`  모드: ${isDryRun ? '🧪 모의투자' : '💰 실전투자'}`);
  console.log(`  타겟 코인: ${targetCoin}`);
  console.log(`  캔들: ${candleUnit}분봉, ${candleCount}개`);
  console.log(`  최적화 간격: ${interval / 3600000}시간`);
  console.log(`  개체군 크기: ${envRaw('POPULATION_SIZE') || 20}`);
  console.log(`  세대 수: ${envRaw('GENERATIONS') || 10}`);

  if (isDryRun) {
    console.log(`\n💡 드라이 모드: 더 짧은 간격(${interval / 3600000}시간)으로 최적화`);
  }

  const optimizer = new ParameterOptimizer({
    populationSize: envNumber('POPULATION_SIZE', NaN) || 20,
    generations: envNumber('GENERATIONS', NaN) || 10,
    mutationRate: envNumber('MUTATION_RATE', NaN) || 0.2,
    crossoverRate: envNumber('CROSSOVER_RATE', NaN) || 0.7,
    eliteSize: envNumber('ELITE_SIZE', NaN) || 2
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
        trainingDays: Math.round((candles.length * candleUnit) / (60 * 24)),
        fitness: fitness,
        parameters: optimalParams,
        note: '지속적 최적화를 통해 생성된 파라미터입니다.'
      };

      const activeConfigFile = optimizationStoragePaths.optimalConfigFile.absolutePath;
      await writeOptimizerJsonAtomically(activeConfigFile, config);

      console.log(`\n💾 최적 파라미터 저장: ${activeConfigFile}`);

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
        fitness: fitness,
        parameters: optimalParams
      });

      console.log(`📝 최적화 이력 저장: ${historyFile}`);

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runContinuousOptimization().catch(error => {
    console.error('치명적 오류:', error);
    process.exit(1);
  });
}
