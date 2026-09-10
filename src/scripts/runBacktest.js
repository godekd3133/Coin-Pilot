import dotenv from 'dotenv';
import UpbitAPI from '../api/upbit.js';
import BacktestEngine from '../backtest/backtestEngine.js';
import fs from 'fs';

dotenv.config();

/**
 * 여러 번의 API 호출로 충분한 분봉 데이터 수집
 * @param {UpbitAPI} upbit - Upbit API 인스턴스
 * @param {string} market - 마켓 코드
 * @param {number} unit - 분봉 단위 (1, 3, 5, 15, 30, 60, 240)
 * @param {number} totalCount - 총 수집할 캔들 수
 * @returns {Array} 캔들 데이터 배열 (최신순)
 */
async function getMultipleMinuteCandles(upbit, market, unit, totalCount) {
  const maxPerRequest = 200; // Upbit API 제한
  const allCandles = [];
  let to = null; // 처음에는 현재 시간부터

  while (allCandles.length < totalCount) {
    const count = Math.min(maxPerRequest, totalCount - allCandles.length);

    try {
      let candles;
      if (to) {
        // to 파라미터를 사용하여 이전 데이터 요청
        candles = await upbit.requestWithRetry(async () => {
          const axios = (await import('axios')).default;
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

      // 다음 요청을 위해 가장 오래된 캔들의 시간 저장
      const oldestCandle = candles[candles.length - 1];
      to = oldestCandle.candle_date_time_utc;

      console.log(`  수집: ${allCandles.length}/${totalCount} 캔들`);

      // API 요청 간격 (100ms)
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error('캔들 데이터 수집 오류:', error.message);
      break;
    }
  }

  return allCandles;
}

async function runBacktest() {
  console.log('🔄 백테스팅 시작...\n');

  const upbit = new UpbitAPI(
    process.env.UPBIT_ACCESS_KEY || '',
    process.env.UPBIT_SECRET_KEY || ''
  );

  const targetCoin = process.env.TARGET_COIN || 'KRW-BTC';
  const candleUnit = parseInt(process.env.BACKTEST_CANDLE_UNIT) || 15; // 15분봉 기본
  const candleCount = parseInt(process.env.BACKTEST_CANDLE_COUNT) || 500; // 500개 캔들

  console.log(`타겟 코인: ${targetCoin}`);
  console.log(`캔들: ${candleUnit}분봉, ${candleCount}개\n`);

  // 분봉 데이터 가져오기 (여러 번 API 호출)
  console.log('📊 분봉 데이터 수집 중...');
  const candles = await getMultipleMinuteCandles(upbit, targetCoin, candleUnit, candleCount);
  console.log(`\n데이터 수집 완료: ${candles.length}개 캔들\n`);

  // 백테스트 엔진 초기화
  const backtest = new BacktestEngine({
    initialBalance: 1000000,
    tradingFee: 0.0005,
    slippage: 0.001
  });

  // 전략 설정
  // 백테스팅에서는 뉴스 데이터가 없으므로 기술적 분석 가중치를 높이고 임계값을 조정
  const strategy = {
    rsiPeriod: parseInt(process.env.RSI_PERIOD) || 14,
    rsiOversold: parseInt(process.env.RSI_OVERSOLD) || 30,
    rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT) || 70,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 5,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 10,
    investmentAmount: 100000,
    // 백테스팅 전용 설정: 뉴스 없이 기술적 분석만 사용
    technicalWeight: 0.9,  // 기술적 분석 90%
    newsWeight: 0.1,       // 뉴스 10% (neutral이므로 영향 최소화)
    buyThreshold: 55,      // 매수 임계값 낮춤 (기본 60)
    sellThreshold: 55      // 매도 임계값 낮춤 (기본 60)
  };

  // 백테스트 실행
  const result = await backtest.run(candles, strategy);

  // 결과 출력
  backtest.printResults(result);

  // 결과 저장
  const resultsFile = 'backtest_results.json';
  fs.writeFileSync(
    resultsFile,
    JSON.stringify(result, null, 2),
    'utf8'
  );

  console.log(`\n💾 결과 저장: ${resultsFile}`);
}

runBacktest().catch(error => {
  console.error('백테스팅 오류:', error);
  process.exit(1);
});
