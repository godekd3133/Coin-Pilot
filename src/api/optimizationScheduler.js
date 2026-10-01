import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getPaperEvidenceMutationLock } from '../research/paperEvidenceMutationGuard.js';
import { fetchCompleteUpbitCandleHistory } from '../market-data/completeUpbitCandleHistory.js';
import { appendOptimizerHistory } from '../runtime/optimizerHistoryStore.js';
import { envInt, envNumber, envString } from '../config/envConfig.js';

/**
 * 레거시 자동 최적화 스케줄러.
 *
 * HTTP 서버 밖의 독립 책임: 상태 파일 로드/저장, 주기 타이머, 캔들 수집,
 * 파라미터 최적화 실행, 최적화 결과 적용. 후보 비교 결과는 history에만
 * 기록하고 active 설정이나 trader에는 적용하지 않는다 — 라이브 적용 게이트는
 * 호출자 계약이 소유한다.
 */
export class OptimizationScheduler {
  constructor({
    tradingSystem = null,
    publicMarketDataSource = null,
    optimizationStoragePaths,
    // 파일 경로는 서버가 주입한다 — 테스트가 인스턴스 필드로 덮어쓰는 계약을
    // 보존하기 위해 getter 함수로 받는다.
    getStateFile = null,
    getHistoryFile = null,
    getOptimalConfigFile = null,
    getTradingSystem = null,
    getPublicMarketDataSource = null,
    collectCandleData = null,
    createParameterOptimizer = null,
    applyOptimalParameters = null,
    projectRoot = process.cwd(),
    logger = console
  } = {}) {
    this._tradingSystem = getTradingSystem || (() => tradingSystem);
    this._publicSource = getPublicMarketDataSource || (() => publicMarketDataSource);
    // owner public surface를 거쳐 호출 — 인스턴스 수준에서 메서드를 덮어쓰는
    // 호출자(테스트 포함)가 runCycle 내부에서도 같은 계약을 갖게 한다.
    this._collectCandleData = collectCandleData ||
      ((market, unit, totalCount, maxPerRequest) =>
        this.collectCandleData(market, unit, totalCount, maxPerRequest));
    this._createParameterOptimizer = createParameterOptimizer ||
      (options => this.createParameterOptimizer(options));
    this._applyOptimalParameters = applyOptimalParameters ||
      (params => this.applyOptimalParameters(params));
    this.storagePaths = optimizationStoragePaths;
    this.projectRoot = projectRoot || process.cwd();
    this.logger = logger;
    this._getStateFile = getStateFile;
    this._getHistoryFile = getHistoryFile;
    this._getOptimalConfigFile = getOptimalConfigFile;

    this.state = {
      enabled: true,          // 기본값: 자동 최적화 활성화
      interval: 21600000,     // 기본 6시간
      isRunning: false,
      lastRun: null,
      nextRun: null
    };
    this.timer = null;
  }

  get stateFile() {
    return this._getStateFile?.() ||
      this.storagePaths?.optimizationStateFile?.absolutePath ||
      path.join(this.projectRoot, 'optimization_state.json');
  }

  get historyFile() {
    return this._getHistoryFile?.() ||
      this.storagePaths?.optimizationHistoryFile?.absolutePath ||
      path.join(this.projectRoot, 'optimization_history.json');
  }

  get optimalConfigFile() {
    return this._getOptimalConfigFile?.() ||
      this.storagePaths?.optimalConfigFile?.absolutePath ||
      path.join(this.projectRoot, 'optimal_config.json');
  }

  loadState() {
    try {
      const stateFile = this.stateFile;
      if (fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        this.state = { ...this.state, ...saved };

        // 서버 재시작 시 스케줄러 복원
        if (this.state.enabled) {
          this.start();
        }
      }
    } catch (error) {
      console.error('최적화 상태 로드 실패:', error.message);
    }
  }

  save(state = this.state) {
    const stateFile = this.stateFile;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const tempFile = path.join(
      path.dirname(stateFile),
      `.${path.basename(stateFile)}.${process.pid}.${randomUUID()}.tmp`
    );
    let descriptor = null;
    let tempCreated = false;

    try {
      const saveData = {
        enabled: state.enabled,
        interval: state.interval,
        lastRun: state.lastRun
      };
      descriptor = fs.openSync(tempFile, 'wx', 0o600);
      tempCreated = true;
      fs.writeFileSync(descriptor, JSON.stringify(saveData, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(tempFile, stateFile);
      tempCreated = false;
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original write/rename error.
        }
      }
      if (tempCreated) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Preserve the original write/rename error.
        }
      }
      console.error('최적화 상태 저장 실패:', error.message);
      throw error;
    }
  }

  start() {
    this.stop(); // 기존 타이머 정리

    const interval = this.state.interval;
    this.state.nextRun = new Date(Date.now() + interval).toISOString();

    console.log(`🧬 자동 최적화 스케줄러 시작 (주기: ${interval / 3600000}시간)`);

    this.timer = setInterval(() => {
      this.runCycle();
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state.nextRun = null;
    console.log('🧬 자동 최적화 스케줄러 중지');
  }

  async runCycle() {
    if (this.state.isRunning) {
      console.log('⚠️ 이미 최적화가 실행 중입니다.');
      return { blocked: true, reason: 'optimization_already_running' };
    }

    const mutationLock = getPaperEvidenceMutationLock(this._tradingSystem(), 'optimization_cycle');
    if (mutationLock.locked) {
      console.log(`⏸️ paper evidence 보호 중 — 최적화 사이클을 건너뜁니다 (${mutationLock.code}).`);
      this.state.lastBlocked = {
        at: new Date().toISOString(),
        code: mutationLock.code,
        operation: mutationLock.operation,
        sessionId: mutationLock.sessionId
      };
      return { blocked: true, lock: mutationLock };
    }

    try {
      this.state.isRunning = true;
      console.log('\n🧬 자동 최적화 사이클 시작...');

      const targetCoin = envString('TARGET_COIN', 'KRW-BTC');
      const candleUnit = envInt('BACKTEST_CANDLE_UNIT', null) || 15;
      const candleCount = envInt('BACKTEST_CANDLE_COUNT', null) || 500;

      // 캔들 데이터 수집
      console.log(`📊 ${candleUnit}분봉 데이터 수집 중...`);
      const candles = await this._collectCandleData(targetCoin, candleUnit, candleCount);

      if (candles.length < 250) {
        console.log(`⚠️ 데이터 부족 (${candles.length}개), 최적화 건너뜀`);
        return;
      }

      // 최적화 실행
      const optimizer = await this._createParameterOptimizer({
        populationSize: envInt('POPULATION_SIZE', null) || 20,
        generations: envInt('GENERATIONS', null) || 10,
        mutationRate: envNumber('MUTATION_RATE', null) || 0.2,
        crossoverRate: envNumber('CROSSOVER_RATE', null) || 0.7,
        eliteSize: envInt('ELITE_SIZE', null) || 2
      });

      const result = await optimizer.optimize(candles);

      // 후보 비교 결과는 history에만 기록하고 active 설정이나 trader에는 적용하지 않습니다.
      const historyFile = this.historyFile;
      await appendOptimizerHistory(historyFile, history => ({
        timestamp: new Date().toISOString(),
        cycle: history.length + 1,
        targetCoin,
        candleUnit,
        candleCount: candles.length,
        fitness: result.fitness,
        parameters: result.parameters
      }));

      this.state.lastRun = new Date().toISOString();
      if (this.state.enabled) {
        this.state.nextRun = new Date(Date.now() + this.state.interval).toISOString();
      }
      this.save();

      console.log('✅ 후보 비교 완료!');
      console.log(`   예상 수익률: ${result.fitness?.toFixed(2)}%`);

    } catch (error) {
      console.error('❌ 최적화 오류:', error.message);
    } finally {
      this.state.isRunning = false;
    }
  }

  async createParameterOptimizer(options) {
    const { default: ParameterOptimizer } = await import('../optimization/parameterOptimizer.js');
    return new ParameterOptimizer(options);
  }

  async collectCandleData(market, unit, totalCount, maxPerRequest = 200) {
    const publicMarketDataSource = this._publicSource();
    const adapter = this._tradingSystem()?.marketDataAdapter;
    const upbit = this._tradingSystem()?.upbit;
    let readCandlePage;

    if (publicMarketDataSource !== undefined && publicMarketDataSource !== null) {
      if (typeof publicMarketDataSource.getMinuteCandles !== 'function') {
        throw new TypeError('Public market data source has no candle reader.');
      }
      readCandlePage = (...args) => publicMarketDataSource.getMinuteCandles(...args);
    } else if (typeof adapter?.getMinuteCandles === 'function') {
      readCandlePage = (...args) => adapter.getMinuteCandles(...args);
    } else if (typeof upbit?.getMinuteCandles === 'function') {
      readCandlePage = (...args) => upbit.getMinuteCandles(...args);
    }

    if (!readCandlePage) {
      throw new TypeError('Upbit minute-candle reader is unavailable.');
    }

    return fetchCompleteUpbitCandleHistory({
      marketDataClient: {
        getMinuteCandles: (targetMarket, intervalMinutes, count, requestOptions = {}) =>
          readCandlePage(targetMarket, intervalMinutes, count, requestOptions)
      },
      market,
      intervalMinutes: unit,
      totalCount,
      maxPerRequest,
      requestSpacingMs: 0
    });
  }

  /**
   * 최적화된 파라미터를 트레이딩 시스템에 즉시 적용 (핫 리로드)
   */
  applyOptimalParameters(params) {
    if (!params || !this._tradingSystem()) {
      console.log('⚠️ 파라미터 적용 실패: 트레이딩 시스템 없음');
      return { blocked: true, reason: 'trading_system_unavailable' };
    }

    const mutationLock = getPaperEvidenceMutationLock(this._tradingSystem(), 'optimization_apply');
    if (mutationLock.locked) {
      console.log(`⏸️ paper evidence 보호 중 — 최적화 파라미터를 적용하지 않습니다 (${mutationLock.code}).`);
      this.state.lastBlocked = {
        at: new Date().toISOString(),
        code: mutationLock.code,
        operation: mutationLock.operation,
        sessionId: mutationLock.sessionId
      };
      return { blocked: true, lock: mutationLock };
    }

    console.log('🔄 새 파라미터를 트레이딩 시스템에 적용 중...');

    // 1. 트레이딩 시스템 config 업데이트 (19개 전체 파라미터)
    if (this._tradingSystem().config) {
      Object.assign(this._tradingSystem().config, {
        // RSI
        rsiPeriod: params.rsiPeriod,
        rsiOversold: params.rsiOversold,
        rsiOverbought: params.rsiOverbought,
        // MACD
        macdFast: params.macdFast,
        macdSlow: params.macdSlow,
        macdSignal: params.macdSignal,
        // 볼린저 밴드
        bbPeriod: params.bbPeriod,
        bbStdDev: params.bbStdDev,
        // EMA
        emaShort: params.emaShort,
        emaMid: params.emaMid,
        emaLong: params.emaLong,
        // 리스크 관리
        stopLossPercent: params.stopLossPercent,
        takeProfitPercent: params.takeProfitPercent,
        maxSignalRangePercent: params.maxSignalRangePercent,
        trailingStopPercent: params.trailingStopPercent,
        // 매매 임계값
        buyThreshold: params.buyThreshold,
        sellThreshold: params.sellThreshold,
        // 거래량
        volumeMultiplier: params.volumeMultiplier,
        volumePeriod: params.volumePeriod
      });
    }

    // 2. strategyConfig 업데이트 (새로 생성되는 전략에 적용)
    if (this._tradingSystem().strategyConfig) {
      Object.assign(this._tradingSystem().strategyConfig, {
        stopLossPercent: params.stopLossPercent,
        takeProfitPercent: params.takeProfitPercent,
        maxSignalRangePercent: params.maxSignalRangePercent,
        trailingStopPercent: params.trailingStopPercent,
        buyThreshold: params.buyThreshold,
        sellThreshold: params.sellThreshold,
        technicalWeight: params.technicalWeight,
        newsWeight: params.technicalWeight ? (1 - params.technicalWeight) : undefined
      });
    }

    // 3. 기존 전략 인스턴스들 업데이트
    if (this._tradingSystem().strategies) {
      for (const [, strategy] of this._tradingSystem().strategies.entries()) {
        if (strategy.config) {
          Object.assign(strategy.config, {
            stopLossPercent: params.stopLossPercent,
            takeProfitPercent: params.takeProfitPercent,
            maxSignalRangePercent: params.maxSignalRangePercent,
            trailingStopPercent: params.trailingStopPercent,
            buyThreshold: params.buyThreshold,
            sellThreshold: params.sellThreshold,
            technicalWeight: params.technicalWeight,
            newsWeight: params.technicalWeight ? (1 - params.technicalWeight) : undefined
          });
        }
      }
    }

    // 4. 투자 비율 업데이트
    if (params.investmentRatio !== undefined) {
      this._tradingSystem().investmentRatio = params.investmentRatio;
    }

    console.log('✅ 새 파라미터 적용 완료 (19개 파라미터)');
    console.log(`   RSI: ${params.rsiPeriod}/${params.rsiOversold}/${params.rsiOverbought}`);
    console.log(`   MACD: ${params.macdFast}/${params.macdSlow}/${params.macdSignal}`);
    console.log(`   BB: ${params.bbPeriod}/±${params.bbStdDev}`);
    console.log(`   EMA: ${params.emaShort}/${params.emaMid}/${params.emaLong}`);
    console.log(`   손절/익절/트레일링: ${params.stopLossPercent}%/${params.takeProfitPercent}%/${params.trailingStopPercent}%`);
    console.log(`   매매 임계: 매수 ${params.buyThreshold} / 매도 ${params.sellThreshold}`);
    console.log(`   거래량: ×${params.volumeMultiplier}/${params.volumePeriod}기간`);
    if (params.technicalWeight) {
      console.log(`   가중치: 기술 ${(params.technicalWeight * 100).toFixed(0)}% / 뉴스 ${((1 - params.technicalWeight) * 100).toFixed(0)}%`);
    }
    if (params.investmentRatio) {
      console.log(`   투자비율: ${(params.investmentRatio * 100).toFixed(1)}%`);
    }
    return { blocked: false };
  }
}

export default OptimizationScheduler;
