import BacktestEngine from '../backtest/backtestEngine.js';
import axios from 'axios';

/**
 * 유전 알고리즘 기반 파라미터 최적화
 */
class ParameterOptimizer {
  constructor(config = {}) {
    this.config = {
      populationSize: config.populationSize || 20,
      generations: config.generations || 10,
      mutationRate: config.mutationRate || 0.2,
      crossoverRate: config.crossoverRate || 0.7,
      eliteSize: config.eliteSize || 2,
      ...config
    };

    // 확장된 파라미터 범위 (소수점 지원)
    // 트레이딩에서 사용하는 모든 19개 파라미터 포함
    this.parameterRanges = {
      // === RSI 파라미터 ===
      rsiPeriod: { min: 5, max: 30, step: 1 },
      rsiOversold: { min: 15, max: 45, step: 1 },
      rsiOverbought: { min: 55, max: 85, step: 1 },

      // === MACD 파라미터 ===
      macdFast: { min: 5, max: 20, step: 1 },
      macdSlow: { min: 15, max: 45, step: 1 },
      macdSignal: { min: 5, max: 15, step: 1 },

      // === 볼린저 밴드 파라미터 ===
      bbPeriod: { min: 10, max: 30, step: 1 },
      bbStdDev: { min: 1.5, max: 3.0, step: 0.1 },

      // === EMA 파라미터 ===
      emaShort: { min: 3, max: 20, step: 1 },
      emaMid: { min: 15, max: 50, step: 1 },
      emaLong: { min: 30, max: 200, step: 5 },

      // === 리스크 관리 ===
      stopLossPercent: { min: 1, max: 15, step: 0.5 },
      takeProfitPercent: { min: 2, max: 30, step: 0.5 },
      trailingStopPercent: { min: 0.5, max: 10, step: 0.5 },

      // === 매매 임계값 ===
      buyThreshold: { min: 40, max: 80, step: 1 },
      sellThreshold: { min: 40, max: 80, step: 1 },

      // === 거래량 파라미터 ===
      volumeMultiplier: { min: 1.0, max: 3.0, step: 0.1 },
      volumePeriod: { min: 5, max: 30, step: 1 },

      // === 가중치 설정 (기술적 분석 vs 뉴스) ===
      technicalWeight: { min: 0.4, max: 0.9, step: 0.05 },

      // === 투자 비율 (총 자산 대비) ===
      investmentRatio: { min: 0.02, max: 0.15, step: 0.01 }
    };

    // 저장된 파라미터 로드 (엘리트 시드로 사용)
    this.savedParams = this.loadSavedParameters();
    this.bestIndividuals = [];
  }

  /**
   * 최적화 실행
   */
  async optimize(historicalData) {
    console.log('\n🧬 유전 알고리즘 기반 파라미터 최적화 시작');
    console.log(`개체군 크기: ${this.config.populationSize}`);
    console.log(`세대 수: ${this.config.generations}`);
    console.log(`변이율: ${this.config.mutationRate * 100}%`);
    console.log('='.repeat(80));

    // 초기 개체군 생성
    let population = this.initializePopulation();

    for (let gen = 0; gen < this.config.generations; gen++) {
      console.log(`\n📊 세대 ${gen + 1}/${this.config.generations}`);

      // 적합도 평가
      const fitnessScores = await this.evaluatePopulation(population, historicalData);

      // 결과를 적합도 순으로 정렬
      const rankedPopulation = population
        .map((individual, index) => ({
          individual,
          fitness: fitnessScores[index]
        }))
        .sort((a, b) => b.fitness - a.fitness);

      // 최고 개체 출력
      const best = rankedPopulation[0];
      console.log(`\n🏆 최고 개체:`);
      console.log(`  적합도 (수익률): ${best.fitness.toFixed(2)}%`);
      console.log(`  파라미터:`, best.individual);

      this.bestIndividuals.push({
        generation: gen + 1,
        fitness: best.fitness,
        parameters: best.individual
      });

      // 마지막 세대가 아니면 다음 세대 생성
      if (gen < this.config.generations - 1) {
        population = this.createNextGeneration(rankedPopulation);
      }
    }

    // 최종 최적 파라미터
    const optimal = this.bestIndividuals.reduce((best, current) =>
      current.fitness > best.fitness ? current : best
    );

    console.log('\n' + '='.repeat(80));
    console.log('✨ 최적화 완료!');
    console.log('='.repeat(80));
    console.log(`\n최적 파라미터 (세대 ${optimal.generation}):`);
    console.log(optimal.parameters);
    console.log(`\n예상 수익률: ${optimal.fitness.toFixed(2)}%`);
    console.log('='.repeat(80));

    // parameters와 fitness 모두 반환
    return {
      parameters: optimal.parameters,
      fitness: optimal.fitness,
      generation: optimal.generation
    };
  }

  /**
   * 저장된 파라미터 로드 (optimal_config.json에서)
   */
  loadSavedParameters() {
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(process.cwd(), 'optimal_config.json');

      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.parameters) {
          console.log('📂 기존 최적화 파라미터 로드됨 (엘리트 시드로 사용)');
          return config.parameters;
        }
      }
    } catch (error) {
      console.log('⚠️ 저장된 파라미터 로드 실패:', error.message);
    }
    return null;
  }

  /**
   * 초기 개체군 생성 (저장된 파라미터를 엘리트로 포함)
   */
  initializePopulation() {
    const population = [];

    // 저장된 파라미터가 있으면 첫 번째 엘리트로 추가
    if (this.savedParams) {
      const elite = this.normalizeIndividual(this.savedParams);
      population.push(elite);
      console.log('  ⭐ 저장된 파라미터를 엘리트 시드로 추가');
    }

    // 나머지는 랜덤 생성
    while (population.length < this.config.populationSize) {
      population.push(this.createRandomIndividual());
    }

    return population;
  }

  /**
   * 개체를 유효한 범위로 정규화
   */
  normalizeIndividual(params) {
    const normalized = {};

    for (const [param, range] of Object.entries(this.parameterRanges)) {
      if (params[param] !== undefined) {
        // 범위 내로 클램핑
        let value = params[param];
        value = Math.max(range.min, Math.min(range.max, value));
        // step에 맞게 반올림
        value = Math.round(value / range.step) * range.step;
        normalized[param] = value;
      } else {
        // 없는 파라미터는 랜덤 생성
        const possibleValues = [];
        for (let val = range.min; val <= range.max; val += range.step) {
          possibleValues.push(val);
        }
        normalized[param] = possibleValues[Math.floor(Math.random() * possibleValues.length)];
      }
    }

    return normalized;
  }

  /**
   * 무작위 개체 생성
   */
  createRandomIndividual() {
    const individual = {};

    for (const [param, range] of Object.entries(this.parameterRanges)) {
      const possibleValues = [];
      for (let val = range.min; val <= range.max; val += range.step) {
        possibleValues.push(val);
      }
      individual[param] = possibleValues[Math.floor(Math.random() * possibleValues.length)];
    }

    return individual;
  }

  /**
   * 개체군 평가
   */
  async evaluatePopulation(population, historicalData) {
    console.log('  개체 평가 중...');

    const backtest = new BacktestEngine({ initialBalance: 1000000 });
    const fitnessScores = [];

    for (let i = 0; i < population.length; i++) {
      const individual = population[i];

      try {
        const result = await backtest.run(historicalData, {
          ...individual,
          investmentAmount: 100000,
          // 백테스팅 전용: 뉴스 없이 기술적 분석 중심
          technicalWeight: 0.9,
          newsWeight: 0.1
        });

        // 적합도 함수: 수익률에 리스크 조정
        // 높은 수익률 + 낮은 최대 낙폭 + 높은 샤프 비율
        let fitness = result.totalReturnPercent;

        // 최대 낙폭 페널티
        if (result.maxDrawdown > 30) {
          fitness *= 0.5;
        } else if (result.maxDrawdown > 20) {
          fitness *= 0.7;
        }

        // 샤프 비율 보너스
        if (result.sharpeRatio > 1) {
          fitness *= 1.2;
        }

        // 승률 보너스
        if (result.winRate > 60) {
          fitness *= 1.1;
        }

        // 거래 횟수 고려 (너무 적으면 페널티)
        if (result.totalTrades < 5) {
          fitness *= 0.5;
        }

        fitnessScores.push(fitness);
      } catch (error) {
        console.error(`  개체 ${i + 1} 평가 실패:`, error.message);
        fitnessScores.push(-Infinity);
      }

      // 진행상황 표시
      if ((i + 1) % 5 === 0 || i === population.length - 1) {
        console.log(`  진행: ${i + 1}/${population.length}`);
      }
    }

    return fitnessScores;
  }

  /**
   * 다음 세대 생성
   */
  createNextGeneration(rankedPopulation) {
    const nextGeneration = [];

    // 엘리트 보존
    for (let i = 0; i < this.config.eliteSize; i++) {
      nextGeneration.push({ ...rankedPopulation[i].individual });
    }

    // 나머지는 선택, 교차, 변이를 통해 생성
    while (nextGeneration.length < this.config.populationSize) {
      // 토너먼트 선택
      const parent1 = this.tournamentSelection(rankedPopulation);
      const parent2 = this.tournamentSelection(rankedPopulation);

      // 교차
      let offspring;
      if (Math.random() < this.config.crossoverRate) {
        offspring = this.crossover(parent1, parent2);
      } else {
        offspring = { ...parent1 };
      }

      // 변이
      if (Math.random() < this.config.mutationRate) {
        offspring = this.mutate(offspring);
      }

      nextGeneration.push(offspring);
    }

    return nextGeneration;
  }

  /**
   * 토너먼트 선택
   */
  tournamentSelection(rankedPopulation, tournamentSize = 3) {
    const tournament = [];

    for (let i = 0; i < tournamentSize; i++) {
      const randomIndex = Math.floor(Math.random() * rankedPopulation.length);
      tournament.push(rankedPopulation[randomIndex]);
    }

    const winner = tournament.reduce((best, current) =>
      current.fitness > best.fitness ? current : best
    );

    return winner.individual;
  }

  /**
   * 교차 (Crossover)
   */
  crossover(parent1, parent2) {
    const offspring = {};
    const params = Object.keys(this.parameterRanges);

    // 단일점 교차
    const crossoverPoint = Math.floor(Math.random() * params.length);

    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      offspring[param] = i < crossoverPoint ? parent1[param] : parent2[param];
    }

    return offspring;
  }

  /**
   * 변이 (Mutation)
   */
  mutate(individual) {
    const mutated = { ...individual };
    const params = Object.keys(this.parameterRanges);
    const paramToMutate = params[Math.floor(Math.random() * params.length)];

    const range = this.parameterRanges[paramToMutate];
    const possibleValues = [];
    for (let val = range.min; val <= range.max; val += range.step) {
      possibleValues.push(val);
    }

    mutated[paramToMutate] = possibleValues[Math.floor(Math.random() * possibleValues.length)];

    return mutated;
  }

  /**
   * 여러 번의 API 호출로 충분한 분봉 데이터 수집
   */
  async getMultipleMinuteCandles(upbitAPI, market, unit, totalCount) {
    const maxPerRequest = 200;
    const allCandles = [];
    let to = null;

    while (allCandles.length < totalCount) {
      const count = Math.min(maxPerRequest, totalCount - allCandles.length);

      try {
        let candles;
        if (to) {
          candles = await upbitAPI.requestWithRetry(async () => {
            const response = await axios.get(
              `https://api.upbit.com/v1/candles/minutes/${unit}`,
              upbitAPI.getRequestConfig({ params: { market, count, to } })
            );
            return response.data;
          });
        } else {
          candles = await upbitAPI.getMinuteCandles(market, unit, count);
        }

        if (!candles || candles.length === 0) break;

        allCandles.push(...candles);
        const oldestCandle = candles[candles.length - 1];
        to = oldestCandle.candle_date_time_utc;

        await this.sleep(100);
      } catch (error) {
        console.error(`캔들 데이터 수집 오류 (${market}):`, error.message);
        break;
      }
    }

    return allCandles;
  }

  /**
   * 지속적 최적화 (백그라운드에서 실행)
   */
  async continuousOptimization(upbitAPI, targetCoin, interval = 86400000) {
    console.log('\n🔄 지속적 파라미터 최적화 시작');
    console.log(`간격: ${interval / 3600000}시간마다`);

    const candleUnit = parseInt(process.env.BACKTEST_CANDLE_UNIT) || 15;
    const candleCount = parseInt(process.env.BACKTEST_CANDLE_COUNT) || 500;

    while (true) {
      try {
        console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 최적화 사이클 시작`);

        // 분봉 데이터 가져오기
        console.log(`📊 ${candleUnit}분봉 데이터 수집 중...`);
        const candles = await this.getMultipleMinuteCandles(upbitAPI, targetCoin, candleUnit, candleCount);

        if (candles.length < 250) {
          console.log(`데이터 부족 (${candles.length}개), 다음 사이클 대기...`);
          await this.sleep(interval);
          continue;
        }

        console.log(`✅ 데이터 수집 완료: ${candles.length}개 캔들`);

        // 최적화 실행
        const optimalParams = await this.optimize(candles);

        // 결과 저장
        this.saveOptimalParameters(optimalParams);

        console.log('\n✅ 최적화 완료, 파라미터 업데이트됨');
      } catch (error) {
        console.error('최적화 오류:', error.message);
      }

      // 다음 사이클까지 대기
      console.log(`\n⏳ 다음 최적화까지 ${interval / 3600000}시간 대기...`);
      await this.sleep(interval);
    }
  }

  /**
   * 최적 파라미터 저장
   */
  saveOptimalParameters(params) {
    const fs = require('fs');
    const path = require('path');

    const configPath = path.join(process.cwd(), 'optimal_config.json');

    const config = {
      updatedAt: new Date().toISOString(),
      parameters: params,
      note: '자동 최적화를 통해 생성된 파라미터입니다.'
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`\n💾 최적 파라미터 저장: ${configPath}`);
  }

  /**
   * 대기
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default ParameterOptimizer;
