import UpbitAPI from '../api/upbit.js';
import { comprehensiveAnalysis } from '../analysis/technicalIndicators.js';
import NewsMonitor from '../analysis/newsMonitor.js';
import TradingStrategy from '../strategy/tradingStrategy.js';
import OversoldReactionStrategy from '../strategy/oversoldReactionStrategy.js';
import { calculateCostAdjustedBreakEvenPrice } from '../strategy/protectionPrices.js';
import {
  inspectLatestCandleFreshness,
  resolveMaxCandleAgeSeconds
} from '../risk/candleFreshness.js';
import {
  createLossCircuitBreakerState,
  getLossCircuitBreakerStatus,
  isLossCircuitCoolingDown,
  registerLoss
} from '../risk/lossCircuitBreaker.js';
import {
  createRiskMonitorState,
  getRiskMonitorStatus,
  recordRiskMonitorFailure,
  recordRiskMonitorSuccess,
  resolveMaxRiskDataGapSeconds
} from '../risk/riskMonitor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveLossCircuitBreakerConfig(config = {}) {
  const configuredCount = Number(config.lossCircuitBreakerCount);
  const configuredWindow = Number(config.lossCircuitBreakerWindowMinutes);
  const configuredCooldown = Number(config.lossCircuitBreakerCooldownMinutes);
  return {
    maxLosses: Number.isFinite(configuredCount) && configuredCount > 0
      ? Math.max(1, Math.floor(configuredCount))
      : 0,
    windowMinutes: Number.isFinite(configuredWindow) && configuredWindow > 0
      ? configuredWindow
      : 30,
    cooldownMinutes: Number.isFinite(configuredCooldown) && configuredCooldown > 0
      ? configuredCooldown
      : 60
  };
}

function resolveSignalWindowEntryLimit(config = {}) {
  const configuredLimit = Number(config.maxEntriesPerSignalWindow);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(100, Math.max(1, Math.floor(configuredLimit)))
    : 0;
}

function normalizeSignalWindowEntryCounts(existing) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return {};
  return Object.fromEntries(
    Object.entries(existing)
      .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
      .map(([signalKey, count]) => [signalKey, Math.floor(Number(count))])
      .slice(-2000)
  );
}

function validTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

/**
 * Add legacy strict losses to the global circuit state when an older ledger
 * does not have the new field yet. Existing state is preserved and duplicate
 * timestamps are removed so a process restart cannot count a loss twice.
 */
function hydrateLossCircuitBreakerState(existingState, historicalLossTimes, config) {
  const state = existingState && typeof existingState === 'object'
    ? existingState
    : createLossCircuitBreakerState();
  const timestamps = [
    ...(Array.isArray(state.lossTimestamps) ? state.lossTimestamps : []),
    ...(Array.isArray(historicalLossTimes) ? historicalLossTimes : [])
  ]
    .map(validTimestamp)
    .filter(timestamp => timestamp !== null);
  state.lossTimestamps = [...new Set(timestamps)].sort((a, b) => a - b).slice(-2000);
  state.cooldownUntil = Math.max(0, Number(state.cooldownUntil) || 0);

  const circuitConfig = resolveLossCircuitBreakerConfig(config);
  if (circuitConfig.maxLosses > 0) {
    const now = Date.now();
    const windowMs = circuitConfig.windowMinutes * 60 * 1000;
    state.lossTimestamps = state.lossTimestamps.filter(timestamp => timestamp > now - windowMs);
    if (state.lossTimestamps.length >= circuitConfig.maxLosses) {
      const latestLoss = state.lossTimestamps.at(-1);
      state.cooldownUntil = Math.max(
        state.cooldownUntil,
        latestLoss + circuitConfig.cooldownMinutes * 60 * 1000
      );
    }
  }

  return state;
}

function calculateLiveMarketReturn(candles, lookback) {
  const closedCandles = Array.isArray(candles) ? candles.slice(1) : [];
  const currentClose = Number(closedCandles[0]?.trade_price);
  const referenceClose = Number(closedCandles[lookback]?.trade_price);
  if (!Number.isFinite(currentClose) || !Number.isFinite(referenceClose) || referenceClose <= 0) {
    return null;
  }
  return ((currentClose - referenceClose) / referenceClose) * 100;
}

function summarizeLiveMarketRegime(analyses, config = {}) {
  if (config.marketRegimeEnabled !== true) {
    return {
      enabled: false,
      available: true,
      confirmed: true,
      breadth: 1,
      averageReturnPercent: 0,
      marketCount: analyses.length,
      positiveMarketCount: analyses.length
    };
  }

  const minReturnPercent = Number.isFinite(Number(config.marketRegimeMinReturnPercent))
    ? Number(config.marketRegimeMinReturnPercent)
    : -0.2;
  const minBreadth = Math.max(0, Math.min(1, Number.isFinite(Number(config.marketRegimeMinBreadth))
    ? Number(config.marketRegimeMinBreadth)
    : 0.5));
  const returns = analyses
    .map(analysis => Number(analysis?.marketReturnPercent))
    .filter(Number.isFinite);
  const positiveMarketCount = returns.filter(value => value >= minReturnPercent).length;
  const breadth = returns.length > 0 ? positiveMarketCount / returns.length : 0;
  const averageReturnPercent = returns.length > 0
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : 0;
  return {
    enabled: true,
    available: returns.length > 0,
    confirmed: returns.length > 0 && breadth >= minBreadth && averageReturnPercent >= minReturnPercent,
    lookback: Math.max(1, Math.floor(Number(config.marketRegimeLookback) || 5)),
    minBreadth,
    minReturnPercent,
    breadth,
    averageReturnPercent,
    marketCount: returns.length,
    positiveMarketCount
  };
}

class MultiCoinTrader {
  constructor(config) {
    this.config = config;
    const configuredStorageMiB = config.paperMinimumStorageMiB ?? process.env.SCALP_PAPER_MIN_STORAGE_MIB;
    const parsedStorageMiB = Number(configuredStorageMiB);
    this.paperMinimumStorageMiB = Number.isFinite(parsedStorageMiB) && parsedStorageMiB >= 128
      ? parsedStorageMiB
      : 1024;
    this.upbit = new UpbitAPI(config.accessKey, config.secretKey, {
      requestTimeoutMs: config.upbitRequestTimeoutMs
    });
    this.riskUpbit = new UpbitAPI(config.accessKey, config.secretKey, {
      requestTimeoutMs: config.upbitRequestTimeoutMs
    });
    this.newsMonitor = new NewsMonitor();
    this.strategyMode = config.strategyMode || 'oversold_reaction_scalping';
    this.isScalpingMode = this.strategyMode === 'oversold_reaction_scalping';

    // 각 코인별 전략 인스턴스
    this.strategies = new Map();
    this.targetCoins = config.targetCoins || ['KRW-BTC', 'KRW-ETH'];

    // 전략 설정 (공통) - 최적화 파라미터 포함
    this.strategyConfig = {
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
      buyThreshold: config.buyThreshold || 55,  // 기본값 55로 낮춤 (더 적극적 매수)
      sellThreshold: config.sellThreshold || 55,
      technicalWeight: config.technicalWeight || 0.6,
      newsWeight: config.newsWeight || 0.4,
      buyOnly: config.buyOnly || false,  // 매수 전용 모드
      allowAveraging: this.isScalpingMode ? false : config.allowAveraging !== false,
      rsiPeriod: config.rsiPeriod || 14,
      rsiOversold: config.rsiOversold || 30,
      rsiOverbought: config.rsiOverbought || 70,
      oversoldLookback: config.oversoldLookback || 1,
      entryDelayMinMs: config.entryDelayMinMs,
      entryDelayMaxMs: config.entryDelayMaxMs,
      maxEntryRetracePercent: config.maxEntryRetracePercent,
      maxEntryChasePercent: config.maxEntryChasePercent,
      breakEvenTriggerPercent: config.breakEvenTriggerPercent,
      breakEvenOffsetPercent: config.breakEvenOffsetPercent,
      trailingActivationPercent: config.trailingActivationPercent,
      trailingStopPercent: config.trailingStopPercent,
      maxHoldMinutes: config.maxHoldMinutes,
      maxLosingHoldMinutes: config.maxLosingHoldMinutes,
      maxEntriesPerSignalWindow: resolveSignalWindowEntryLimit(config),
      minReboundPercent: config.minReboundPercent,
      minRsiRecovery: config.minRsiRecovery,
      maxSignalRangePercent: config.maxSignalRangePercent ?? 0,
      minSignalRangePercent: config.minSignalRangePercent ?? 0,
      marketRegimeEnabled: config.marketRegimeEnabled === true,
      marketRegimeLookback: config.marketRegimeLookback,
      marketRegimeMinBreadth: config.marketRegimeMinBreadth,
      marketRegimeMinReturnPercent: config.marketRegimeMinReturnPercent,
      requireReboundBelowOverbought: config.requireReboundBelowOverbought === true,
      cooldownAfterLossMinutes: config.cooldownAfterLossMinutes,
      maxConsecutiveLosses: config.maxConsecutiveLosses,
      lossCircuitBreakerCount: config.lossCircuitBreakerCount,
      lossCircuitBreakerWindowMinutes: config.lossCircuitBreakerWindowMinutes,
      lossCircuitBreakerCooldownMinutes: config.lossCircuitBreakerCooldownMinutes,
      tradingFee: config.tradingFee ?? 0.0005,
      slippage: config.slippage ?? 0.001
    };

    // 추가 매수 허용 옵션 저장
    this.allowAveraging = this.isScalpingMode ? false : config.allowAveraging !== false;

    // 전략은 필요할 때 동적으로 생성 (메모리 효율화)
    // 많은 코인을 분석할 때는 모든 코인에 미리 생성하지 않음
    if (this.targetCoins.length <= 20) {
      this.targetCoins.forEach(coin => {
        this.strategies.set(coin, this.createStrategy());
      });
    }

    this.isRunning = false;
    this.dryRun = config.dryRun !== false;
    this.lastNewsCheck = null;
    this.newsData = null;

    // 리밸런싱 쿨다운 관리
    this.lastRebalanceTime = null;

    // 포트폴리오 관리
    this.maxPositions = config.maxPositions || (this.isScalpingMode ? 3 : 1000);
    this.portfolioAllocation = config.portfolioAllocation || (this.isScalpingMode ? 0.1 : 0.3);
    this.candleUnit = config.candleUnit || (this.isScalpingMode ? 1 : 5);
    this.candleCount = config.candleCount || 200;
    this.maxCandleAgeSeconds = resolveMaxCandleAgeSeconds(config.maxCandleAgeSeconds, this.candleUnit);
    this.config.maxCandleAgeSeconds = this.maxCandleAgeSeconds;
    this.useNews = config.useNews !== false && !this.isScalpingMode;
    this.entryDelayMinMs = config.entryDelayMinMs ?? 1000;
    this.entryDelayMaxMs = config.entryDelayMaxMs ?? 5000;
    this.maxEntryRetracePercent = config.maxEntryRetracePercent ?? 0.25;
    const configuredRiskInterval = config.positionRiskCheckIntervalMs;
    this.positionRiskCheckIntervalMs = configuredRiskInterval === 0
      ? 0
      : Math.max(250, Number(configuredRiskInterval) || (this.isScalpingMode ? 1000 : 5000));
    this.maxRiskDataGapSeconds = resolveMaxRiskDataGapSeconds(
      config.maxRiskDataGapSeconds,
      this.isScalpingMode ? 30 : 0
    );
    this.positionRiskTimer = null;
    this._riskCheckInProgress = false;
    this._orderInProgress = false;
    this._stopRequested = false;
    this.cycleRequestStats = null;
    this.runtimeSignalWindowEntryCounts = new Map();

    // 드라이 모드 가상 포트폴리오
    this.virtualPortfolio = {
      krwBalance: config.dryRunSeedMoney || 10000000,
      holdings: new Map() // coin -> { amount, avgPrice }
    };

    // 초기 시드머니 저장 (누적손익 계산용)
    if (this.dryRun) {
      this.initialSeedMoney = config.dryRunSeedMoney || 10000000;
    } else {
      // 실전 모드: 환경변수로 설정하거나 자동 계산
      this.initialSeedMoney = config.initialSeedMoney || 0;
    }

    const testStoragePrefix = (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT)
      ? path.join(os.tmpdir(), `coin-pilot-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      : null;
    this.virtualPortfolioFile = config.virtualPortfolioFile ||
      process.env.DRY_PORTFOLIO_FILE ||
      (testStoragePrefix ? `${testStoragePrefix}.dry_portfolio.json` : 'dry_portfolio.json');
    this.paperValidationFile = config.paperValidationFile ||
      process.env.PAPER_VALIDATION_FILE ||
      (testStoragePrefix ? `${testStoragePrefix}.paper_validation.json` : 'paper_validation.json');
    // Live mode has no paper ledger, so keep its optional global circuit in
    // memory. DRY_RUN forward sessions replace this reference with their
    // persisted strictRiskState circuit through getStrictLossCircuitBreakerState().
    this.lossCircuitBreaker = createLossCircuitBreakerState();

    // 드라이 모드일 경우 저장된 포트폴리오 로드
    if (this.dryRun) {
      this.loadVirtualPortfolio();
    } else {
      // 실전 모드: 초기 시드머니 파일에서 로드
      this.loadInitialSeedMoney();
    }

    this.paperValidation = this.loadPaperValidation();
    this.riskMonitorState = createRiskMonitorState(this.paperValidation?.riskMonitor);
    this.restorePaperStrategyRiskState();

    // 동적 투자금액 설정 (비율 기반으로 단순화)
    this.investmentRatio = config.investmentRatio || 0.05; // 총 자산의 5%를 기본 투자 비율로
    this.MIN_ORDER_AMOUNT = 5000; // 업비트 최소 주문 금액 (고정)

    // 거래 알림 콜백 (대시보드에서 설정)
    this.onTradeCallback = null;
    // 분석 결과를 대시보드/AI 모니터링으로 전달하는 읽기 전용 콜백.
    // 이 콜백은 주문 결정에 참여하지 않으며, 거래 루프를 기다리게 하지 않는다.
    this.onAnalysisCallback = null;
  }

  /**
   * 거래 알림 콜백 설정
   */
  setTradeCallback(callback) {
    this.onTradeCallback = callback;
  }

  /**
   * 분석 cycle을 읽기 전용 소비자에게 전달한다.
   * AI 자문이나 UI 알림이 실패해도 기존 자동매매 경로에는 영향을 주지
   * 않도록 callback을 fire-and-forget으로 실행한다.
   */
  setAnalysisCallback(callback) {
    this.onAnalysisCallback = typeof callback === 'function' ? callback : null;
  }

  notifyAnalysisCycle(cycleInfo) {
    if (!this.onAnalysisCallback) return;
    try {
      Promise.resolve(this.onAnalysisCallback(cycleInfo)).catch(error => {
        console.error('분석 모니터링 콜백 오류:', error.message);
      });
    } catch (error) {
      console.error('분석 모니터링 콜백 오류:', error.message);
    }
  }

  /**
   * 거래 알림 전송
   */
  notifyTrade(tradeInfo) {
    if (this.onTradeCallback) {
      try {
        this.onTradeCallback(tradeInfo);
      } catch (e) {
        console.error('거래 알림 콜백 오류:', e.message);
      }
    }
  }

  /**
   * 코인별 전략 가져오기 (없으면 동적 생성)
   */
  getStrategy(coin) {
    if (!this.strategies.has(coin)) {
      const strategy = this.createStrategy();
      this.strategies.set(coin, strategy);
      this.applyPaperStrategyRiskState(coin, strategy);
    }
    return this.strategies.get(coin);
  }

  /**
   * Preserve the signal that caused an entry alongside the execution price.
   * This is diagnostic metadata only; it lets forward paper distinguish a
   * weak signal from a loss introduced by delayed execution or slippage.
   */
  decorateEntryPosition(strategy, decision, { executionPrice, delayMs = null } = {}) {
    if (!strategy?.currentPosition) return;
    const rebound = decision?.details?.rebound || {};
    const referencePrice = Number(decision?.entryReferencePrice ?? rebound.referencePrice);
    const price = Number(executionPrice);
    const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null;
    strategy.currentPosition.signalKey = decision?.entrySignalKey || rebound.signalKey || null;
    strategy.currentPosition.signalTime = rebound.candleTime || null;
    strategy.currentPosition.signalReferencePrice = numeric(referencePrice);
    strategy.currentPosition.signalReboundPercent = numeric(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent);
    strategy.currentPosition.signalRsi = numeric(rebound.rsi);
    strategy.currentPosition.signalOversoldRsi = numeric(rebound.oversoldRsi ?? rebound.previousRsi);
    strategy.currentPosition.signalRsiRecovery = numeric(rebound.rsiRecovery);
    strategy.currentPosition.signalVolumeRatio = numeric(rebound.volumeRatio);
    strategy.currentPosition.signalCloseStrength = numeric(rebound.closeStrength);
    strategy.currentPosition.signalTrendSlopePercent = numeric(rebound.trendSlopePercent);
    strategy.currentPosition.signalRangePercent = numeric(rebound.signalRangePercent);
    strategy.currentPosition.entryDelayMs = numeric(delayMs);
    strategy.currentPosition.executionDriftPercent = Number.isFinite(price) && referencePrice > 0
      ? ((price - referencePrice) / referencePrice) * 100
      : null;
  }

  /**
   * 실행 중인 전략 모드에 맞는 전략 인스턴스 생성
   */
  createStrategy() {
    const Strategy = this.isScalpingMode ? OversoldReactionStrategy : TradingStrategy;
    return new Strategy(this.strategyConfig);
  }

  /**
   * 현재 설정으로 기술적 분석을 생성한다.
   * 분석과 지연 후 재검증이 동일한 계산 계약을 사용하도록 한 곳에서 관리한다.
   */
  buildTechnicalAnalysis(candles) {
    return comprehensiveAnalysis(candles, {
      rsiPeriod: this.config.rsiPeriod || 14,
      rsiOversold: this.config.rsiOversold || 30,
      rsiOverbought: this.config.rsiOverbought || 70,
      oversoldLookback: this.config.oversoldLookback || 1,
      macdFast: this.config.macdFast || 12,
      macdSlow: this.config.macdSlow || 26,
      macdSignal: this.config.macdSignal || 9,
      bbPeriod: this.config.bbPeriod || 20,
      bbStdDev: this.config.bbStdDev || 2,
      minReboundPercent: this.config.minReboundPercent || 0.15,
      minRsiRecovery: this.config.minRsiRecovery || 2,
      minVolumeRatio: this.config.minVolumeRatio ?? 1.0,
      volumeLookback: this.config.volumeLookback || 20,
      minCloseStrength: this.config.minCloseStrength ?? 0.65,
      trendPeriod: this.config.trendPeriod || 30,
      trendSlopeLookback: this.config.trendSlopeLookback || 3,
      minTrendSlopePercent: this.config.minTrendSlopePercent ?? -0.2,
      requirePreviousHighBreak: this.config.requirePreviousHighBreak !== false,
      maxSignalRangePercent: this.config.maxSignalRangePercent ?? 0,
      minSignalRangePercent: this.config.minSignalRangePercent ?? 0,
      requireReboundBelowOverbought: this.config.requireReboundBelowOverbought === true,
      signalProfile: this.config.signalProfile || 'rsi_rebound',
      emaPeriod: this.config.emaLong || 20
    });
  }

  /**
   * 총 자산 계산 (KRW + 코인 평가액) - 드라이/실전 모드 모두 지원
   */
  async calculateTotalAssets() {
    if (this.dryRun) {
      // 드라이 모드: 가상 포트폴리오 사용
      let totalAssets = this.virtualPortfolio.krwBalance;

      const holdingCoins = Array.from(this.virtualPortfolio.holdings.keys());
      if (holdingCoins.length > 0) {
        // 현재가 맵 초기화
        const priceMap = new Map();

        try {
          const tickers = await this.upbit.getTicker(holdingCoins);
          // ticker 응답을 맵으로 변환
          if (tickers && Array.isArray(tickers)) {
            for (const ticker of tickers) {
              if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                priceMap.set(ticker.market, ticker.trade_price);
              }
            }
          }
        } catch (error) {
          // ticker 조회 실패 시 priceMap은 비어있음 → 평균단가로 계산됨
        }

        // 모든 보유 코인에 대해 계산 (현재가 또는 평균단가)
        for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
          const currentPrice = priceMap.get(coin);
          if (currentPrice !== undefined) {
            // 현재가로 계산
            totalAssets += currentPrice * holding.amount;
          } else {
            // 현재가 조회 실패 시 평균단가로 계산
            totalAssets += holding.avgPrice * holding.amount;
          }
        }
      }
      return totalAssets;
    } else {
      // 실전 모드: 실제 업비트 계좌 잔액 사용
      const accounts = await this.upbit.getAccounts();
      if (!accounts || !Array.isArray(accounts)) {
        console.error('계좌 조회 실패');
        return 0;
      }

      let totalAssets = 0;

      // KRW 잔액
      const krwAccount = accounts.find(acc => acc.currency === 'KRW');
      if (krwAccount) {
        totalAssets += parseFloat(krwAccount.balance) + parseFloat(krwAccount.locked || 0);
      }

      // 보유 코인 평가액
      const coinAccounts = accounts.filter(acc => acc.currency !== 'KRW' && parseFloat(acc.balance) > 0);
      if (coinAccounts.length > 0) {
        const coinMarkets = coinAccounts.map(acc => `KRW-${acc.currency}`);
        try {
          const tickers = await this.upbit.getTicker(coinMarkets);
          // ticker 응답 유효성 검사
          if (tickers && Array.isArray(tickers) && tickers.length > 0) {
            for (const ticker of tickers) {
              if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                const coinSymbol = ticker.market.split('-')[1];
                const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
                if (coinAccount) {
                  const balance = parseFloat(coinAccount.balance) + parseFloat(coinAccount.locked || 0);
                  totalAssets += ticker.trade_price * balance;
                }
              }
            }
          } else {
            // ticker 조회 실패 시 평균매입가로 계산
            for (const acc of coinAccounts) {
              const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
              totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
            }
          }
        } catch (error) {
          // 현재가 조회 실패 시 평균매입가로 계산
          for (const acc of coinAccounts) {
            const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
            totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
          }
        }
      }
      return totalAssets;
    }
  }

  /**
   * 현재 보유 중인 코인 목록 반환 (백테스팅용)
   */
  async getHeldCoins() {
    if (this.dryRun) {
      // 드라이 모드: 가상 포트폴리오에서 보유 코인 목록 반환
      return Array.from(this.virtualPortfolio.holdings.keys());
    } else {
      // 실전 모드: 실제 업비트 계좌에서 보유 코인 목록 반환
      try {
        const accounts = await this.upbit.getAccounts();
        if (!accounts || !Array.isArray(accounts)) {
          return [];
        }
        return accounts
          .filter(acc => acc.currency !== 'KRW' && parseFloat(acc.balance) > 0)
          .map(acc => `KRW-${acc.currency}`);
      } catch (error) {
        console.error('보유 코인 조회 실패:', error.message);
        return [];
      }
    }
  }

  /**
   * 동적 투자금액 계산 (비율 기반으로 단순화)
   * @param {number} totalAssets - 총 자산
   * @param {Object} signalStrength - 신호 강도 { level, multiplier, score }
   */
  async calculateDynamicInvestmentAmount(totalAssets = null, signalStrength = null) {
    // 총 자산이 전달되지 않으면 계산
    if (totalAssets === null) {
      totalAssets = await this.calculateTotalAssets();
    }

    // 투자금액: 총 자산의 investmentRatio
    let dynamicAmount = totalAssets * this.investmentRatio;

    // 신호 강도에 따른 배수 적용
    if (signalStrength && signalStrength.multiplier > 0) {
      dynamicAmount *= signalStrength.multiplier;
      console.log(`  📊 신호 강도: ${signalStrength.level} (x${signalStrength.multiplier})`);
    }

    // 최소 주문 금액 체크 (업비트 최소 5,000원)
    dynamicAmount = Math.max(this.MIN_ORDER_AMOUNT, dynamicAmount);

    return Math.floor(dynamicAmount);
  }

  /**
   * 누적손익 계산
   */
  async calculateCumulativePnL() {
    const totalAssets = await this.calculateTotalAssets();
    const profit = totalAssets - this.initialSeedMoney;
    const profitPercent = this.initialSeedMoney > 0
      ? ((totalAssets / this.initialSeedMoney) - 1) * 100
      : 0;

    return {
      initialSeedMoney: this.initialSeedMoney,
      totalAssets: Math.round(totalAssets),
      profit: Math.round(profit),
      profitPercent: profitPercent,
      mode: this.dryRun ? 'DRY_RUN' : 'LIVE'
    };
  }

  /**
   * 실전 모드용 초기 시드머니 로드/저장
   */
  loadInitialSeedMoney() {
    const seedFile = 'initial_seed_money.json';

    if (fs.existsSync(seedFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        if (data.initialSeedMoney > 0) {
          this.initialSeedMoney = data.initialSeedMoney;
          console.log(`📂 초기 시드머니 로드됨: ${this.initialSeedMoney.toLocaleString()}원`);
          console.log(`   기록일: ${data.recordedAt || '알 수 없음'}`);
        }
      } catch (error) {
        console.log('⚠️  초기 시드머니 로드 실패:', error.message);
      }
    }
  }

  /**
   * 실전 모드용 초기 시드머니 저장 (최초 1회만)
   */
  async saveInitialSeedMoney() {
    if (this.dryRun) return;

    const seedFile = 'initial_seed_money.json';

    // 이미 저장된 파일이 있으면 스킵
    if (fs.existsSync(seedFile)) {
      return;
    }

    // 현재 총 자산을 초기 시드머니로 저장
    const totalAssets = await this.calculateTotalAssets();

    const data = {
      initialSeedMoney: Math.round(totalAssets),
      recordedAt: new Date().toISOString(),
      note: '실전 모드 초기 투자금 (자동 기록)'
    };

    this.writeJsonAtomically(seedFile, data);
    this.initialSeedMoney = data.initialSeedMoney;
    console.log(`💾 초기 시드머니 저장됨: ${this.initialSeedMoney.toLocaleString()}원`);
  }

  /**
   * 가상 포트폴리오 저장 (드라이 모드)
   */
  saveVirtualPortfolio() {
    if (!this.dryRun) return;

    const portfolioFile = this.virtualPortfolioFile;
    const data = {
      krwBalance: this.virtualPortfolio.krwBalance,
      holdings: {},
      positions: {},
      tradeHistory: {},
      initialSeedMoney: this.initialSeedMoney,
      updatedAt: new Date().toISOString()
    };

    // holdings 저장 (entryTime 포함하여 저장) + 해당 코인의 포지션/이력도 함께 저장
    for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
      const strategy = this.strategies.get(coin);
      data.holdings[coin] = {
        amount: holding.amount,
        avgPrice: holding.avgPrice,
        // strategy에서 entryTime 가져오거나 기존 값 유지
        entryTime: strategy?.currentPosition?.entryTime || holding.entryTime || new Date().toISOString()
      };

      // 해당 코인의 포지션도 함께 저장 (holdings와 positions 동기화)
      if (strategy?.currentPosition) {
        data.positions[coin] = strategy.currentPosition;
      }

      // 해당 코인의 거래 이력도 함께 저장
      if (strategy?.tradeHistory?.length > 0) {
        data.tradeHistory[coin] = strategy.tradeHistory;
      }
    }

    // 추가로 holdings에 없지만 전략에 거래 이력이 있는 코인들도 저장 (매도 완료된 코인 이력 보존)
    for (const [coin, strategy] of this.strategies.entries()) {
      if (!data.tradeHistory[coin] && strategy.tradeHistory?.length > 0) {
        data.tradeHistory[coin] = strategy.tradeHistory;
      }
    }

    this.writeJsonAtomically(portfolioFile, data);
    console.log('💾 가상 포트폴리오 저장됨');
  }

  writeJsonAtomically(file, data) {
    const directory = path.dirname(file);
    if (directory && directory !== '.') fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(temporaryFile, file);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      } catch {
        // Preserve the original write/rename error. A later startup can use
        // the owner-process/heartbeat recovery path if cleanup also fails.
      }
      throw error;
    }
  }

  /**
   * 가상 포트폴리오 리셋 (드라이 모드)
   * @param {number} seedMoney - 새로운 시드머니 (기본: 1000만원)
   */
  resetVirtualPortfolio(seedMoney = 10000000) {
    if (!this.dryRun) {
      console.log('⚠️  실전 모드에서는 포트폴리오 리셋이 불가능합니다');
      return false;
    }

    console.log('\n🔄 가상 포트폴리오 리셋 중...');

    // 가상 포트폴리오 초기화
    this.virtualPortfolio = {
      krwBalance: seedMoney,
      holdings: new Map()
    };

    // 초기 시드머니 업데이트
    this.initialSeedMoney = seedMoney;

    // 모든 전략 인스턴스 초기화
    for (const [, strategy] of this.strategies.entries()) {
      strategy.currentPosition = null;
      strategy.tradeHistory = [];
    }

    // 파일 저장
    const portfolioFile = this.virtualPortfolioFile;
    const data = {
      krwBalance: seedMoney,
      holdings: {},
      positions: {},
      tradeHistory: {},
      initialSeedMoney: seedMoney,
      updatedAt: new Date().toISOString()
    };
    this.writeJsonAtomically(portfolioFile, data);

    console.log(`✅ 포트폴리오 리셋 완료!`);
    console.log(`   시드머니: ${seedMoney.toLocaleString()}원`);
    console.log(`   보유 코인: 0개`);

    return true;
  }

  /**
   * 가상 포트폴리오 로드 (드라이 모드)
   */
  loadVirtualPortfolio() {
    const portfolioFile = this.virtualPortfolioFile;

    if (fs.existsSync(portfolioFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
        this.virtualPortfolio.krwBalance = data.krwBalance;
        this.virtualPortfolio.holdings = new Map(Object.entries(data.holdings || {}));

        // 저장된 초기 시드머니 로드 (없으면 현재 설정값 유지)
        if (data.initialSeedMoney) {
          this.initialSeedMoney = data.initialSeedMoney;
        }

        // 전략의 포지션과 거래 이력 복원
        if (data.positions) {
          for (const [coin, position] of Object.entries(data.positions)) {
            const strategy = this.getStrategy(coin);
            if (strategy) {
              // JSON에서 로드된 날짜 문자열을 Date 객체로 변환
              if (position.entryTime && typeof position.entryTime === 'string') {
                position.entryTime = new Date(position.entryTime);
              }
              strategy.currentPosition = position;
            }
          }
        }

        // tradeHistory 하위 호환성 처리
        // 구버전: tradeHistory가 배열 [] 형태
        // 신버전: tradeHistory가 객체 { coin: [...] } 형태
        if (data.tradeHistory) {
          if (Array.isArray(data.tradeHistory)) {
            // 구버전 형태 (배열): 배열 내 각 거래에서 코인 정보를 추출하여 분류
            console.log('   🔄 구버전 tradeHistory 형식 감지 - 마이그레이션 중...');
            const migratedHistory = {};
            for (const trade of data.tradeHistory) {
              // 거래 기록에서 코인 정보 추출 시도
              const coin = trade.market || trade.coin || null;
              if (coin) {
                if (!migratedHistory[coin]) {
                  migratedHistory[coin] = [];
                }
                migratedHistory[coin].push({
                  ...trade,
                  entryTime: trade.entryTime ? new Date(trade.entryTime) : undefined,
                  exitTime: trade.exitTime ? new Date(trade.exitTime) : undefined
                });
              }
            }
            // 마이그레이션된 이력 적용
            for (const [coin, history] of Object.entries(migratedHistory)) {
              const strategy = this.getStrategy(coin);
              if (strategy) {
                strategy.tradeHistory = history;
              }
            }
          } else {
            // 신버전 형태 (객체)
            for (const [coin, history] of Object.entries(data.tradeHistory)) {
              const strategy = this.getStrategy(coin);
              if (strategy && Array.isArray(history)) {
                // 거래 이력의 날짜들도 Date 객체로 변환
                strategy.tradeHistory = history.map(trade => ({
                  ...trade,
                  entryTime: trade.entryTime ? new Date(trade.entryTime) : undefined,
                  exitTime: trade.exitTime ? new Date(trade.exitTime) : undefined
                }));
              }
            }
          }
        }

        // holdings와 positions 동기화 (holdings에 있는데 positions가 없는 경우)
        let syncedCount = 0;
        for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
          if (holding.amount > 0) {
            const strategy = this.getStrategy(coin);
            if (strategy && !strategy.currentPosition) {
              // holdings에서 position 생성
              strategy.currentPosition = {
                type: 'BUY',
                entryPrice: holding.avgPrice,
                amount: holding.amount,
                entryTime: holding.entryTime ? new Date(holding.entryTime) : new Date(),
                id: Date.now() + syncedCount
              };
              syncedCount++;
            }
          }
        }

        // 구버전 파일 형식 감지 시 신버전으로 자동 마이그레이션
        const needsMigration = Array.isArray(data.tradeHistory) ||
                              data.lastSaved !== undefined ||
                              data.initialSeedMoney === undefined;

        console.log(`📂 가상 포트폴리오 로드됨 (${portfolioFile})`);
        console.log(`   KRW 잔액: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);
        console.log(`   보유 코인: ${this.virtualPortfolio.holdings.size}개`);
        if (syncedCount > 0) {
          console.log(`   🔄 포지션 동기화: ${syncedCount}개 복원됨`);
        }
        console.log(`   마지막 저장: ${data.updatedAt || data.lastSaved || '알 수 없음'}`);

        // 마이그레이션 필요 시 신버전 형식으로 즉시 저장
        if (needsMigration || syncedCount > 0) {
          console.log('   📝 신버전 형식으로 포트폴리오 마이그레이션 저장...');
          this.saveVirtualPortfolio();
        }
      } catch (error) {
        console.log('⚠️  가상 포트폴리오 로드 실패:', error.message);
      }
    }
  }

  loadPaperValidation() {
    if (!this.dryRun || !this.paperValidationFile || !fs.existsSync(this.paperValidationFile)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.paperValidationFile, 'utf8'));
      const cooldownAfterLossMinutes = Number(this.config.cooldownAfterLossMinutes) || 15;
      const maxConsecutiveLosses = Number(this.config.maxConsecutiveLosses) || 3;
      const cooldownUntilByCoin = {};
      const consecutiveLossesByCoin = {};
      const historicalCloses = (Array.isArray(data.strictTrades) ? data.strictTrades : [])
        .filter(trade => (trade?.action === 'CLOSE' || trade?.action === 'PARTIAL_CLOSE') && trade.coin)
        .sort((a, b) => new Date(a.exitTime || 0) - new Date(b.exitTime || 0));
      const historicalLossTimes = [];
      for (const trade of historicalCloses) {
        const coin = trade.coin;
        const profit = Number(trade.profit) || 0;
        if (profit < 0) {
          const consecutiveLosses = (Number(consecutiveLossesByCoin[coin]) || 0) + 1;
          const cooldownMinutes = consecutiveLosses >= maxConsecutiveLosses
            ? Math.max(cooldownAfterLossMinutes, 60)
            : cooldownAfterLossMinutes;
          consecutiveLossesByCoin[coin] = consecutiveLosses;
          const exitTime = validTimestamp(trade.exitTime);
          if (exitTime !== null) {
            historicalLossTimes.push(exitTime);
            cooldownUntilByCoin[coin] = exitTime + cooldownMinutes * 60 * 1000;
          } else {
            cooldownUntilByCoin[coin] = 0;
          }
        } else {
          consecutiveLossesByCoin[coin] = 0;
          cooldownUntilByCoin[coin] = 0;
        }
      }

      const hadRiskState = data.strictRiskState && typeof data.strictRiskState === 'object';
      const riskState = hadRiskState
        ? data.strictRiskState
        : { cooldownUntilByCoin, consecutiveLossesByCoin };
      riskState.cooldownUntilByCoin = riskState.cooldownUntilByCoin || cooldownUntilByCoin;
      riskState.consecutiveLossesByCoin = riskState.consecutiveLossesByCoin || consecutiveLossesByCoin;
      const hadCircuitState = riskState.lossCircuitBreaker && typeof riskState.lossCircuitBreaker === 'object';
      const hadSignalWindowState = riskState.signalWindowEntryCountsByKey &&
        typeof riskState.signalWindowEntryCountsByKey === 'object' &&
        !Array.isArray(riskState.signalWindowEntryCountsByKey);
      riskState.signalWindowEntryCountsByKey = normalizeSignalWindowEntryCounts(
        riskState.signalWindowEntryCountsByKey
      );
      riskState.lossCircuitBreaker = hydrateLossCircuitBreakerState(
        riskState.lossCircuitBreaker,
        historicalLossTimes,
        this.config
      );
      data.strictRiskState = riskState;
      if (!hadRiskState || !hadCircuitState || !hadSignalWindowState) {
        data.strictRiskStateMigratedAt = new Date().toISOString();
      }
      for (const stateKey of ['shadow', 'looseShadow']) {
        const shadow = data[stateKey];
        if (!shadow || typeof shadow !== 'object') continue;
        const shadowLossTimes = (Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [])
          .filter(trade => Number(trade?.netProfit) < 0)
          .map(trade => trade.exitTimestamp || trade.exitTime)
          .map(validTimestamp)
          .filter(timestamp => timestamp !== null);
        shadow.lossCircuitBreaker = hydrateLossCircuitBreakerState(
          shadow.lossCircuitBreaker,
          shadowLossTimes,
          this.config
        );
      }
      return data;
    } catch (error) {
      console.log('⚠️  Paper validation ledger 로드 실패:', error.message);
      return null;
    }
  }

  savePaperValidation() {
    if (!this.dryRun || !this.paperValidation) return;
    this.writeJsonAtomically(this.paperValidationFile, this.paperValidation);
  }

  getStorageStatus() {
    const minimumBytes = this.paperMinimumStorageMiB * 1024 * 1024;
    try {
      if (typeof fs.statfsSync !== 'function') {
        return { available: false, healthy: true, minimumBytes };
      }
      const ledgerDirectory = path.dirname(path.resolve(this.paperValidationFile));
      const stats = fs.statfsSync(ledgerDirectory);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      return {
        available: Number.isFinite(availableBytes),
        healthy: Number.isFinite(availableBytes) && availableBytes >= minimumBytes,
        availableBytes,
        availableMiB: Number.isFinite(availableBytes) ? availableBytes / 1024 / 1024 : null,
        minimumBytes,
        minimumMiB: minimumBytes / 1024 / 1024
      };
    } catch (error) {
      return {
        available: false,
        healthy: false,
        minimumBytes,
        error: error.message
      };
    }
  }

  isProcessAlive(processId) {
    const pid = Number(processId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  getPaperValidationConfigSnapshot() {
    const config = this.config || {};
    const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
    const lossCircuitConfig = resolveLossCircuitBreakerConfig(config);
    return {
      strategyMode: this.strategyMode,
      signalProfile: config.signalProfile || 'rsi_rebound',
      targetCoins: [...this.targetCoins].sort(),
      candleUnit: numericOrNull(this.candleUnit),
      candleCount: numericOrNull(this.candleCount),
      maxCandleAgeSeconds: numericOrNull(this.maxCandleAgeSeconds),
      rsiPeriod: numericOrNull(config.rsiPeriod),
      rsiOversold: numericOrNull(config.rsiOversold),
      rsiOverbought: numericOrNull(config.rsiOverbought),
      oversoldLookback: numericOrNull(config.oversoldLookback),
      minReboundPercent: numericOrNull(config.minReboundPercent),
      minRsiRecovery: numericOrNull(config.minRsiRecovery),
      minVolumeRatio: numericOrNull(config.minVolumeRatio),
      volumeLookback: numericOrNull(config.volumeLookback),
      minCloseStrength: numericOrNull(config.minCloseStrength),
      trendPeriod: numericOrNull(config.trendPeriod),
      trendSlopeLookback: numericOrNull(config.trendSlopeLookback),
      minTrendSlopePercent: numericOrNull(config.minTrendSlopePercent),
      requirePreviousHighBreak: config.requirePreviousHighBreak !== false,
      maxSignalRangePercent: numericOrNull(config.maxSignalRangePercent),
      minSignalRangePercent: numericOrNull(config.minSignalRangePercent),
      marketRegimeEnabled: config.marketRegimeEnabled === true,
      marketRegimeLookback: numericOrNull(config.marketRegimeLookback ?? 5),
      marketRegimeMinBreadth: numericOrNull(config.marketRegimeMinBreadth ?? 0.5),
      marketRegimeMinReturnPercent: numericOrNull(config.marketRegimeMinReturnPercent ?? -0.2),
      requireReboundBelowOverbought: config.requireReboundBelowOverbought === true,
      stopLossPercent: numericOrNull(config.stopLossPercent),
      takeProfitPercent: numericOrNull(config.takeProfitPercent),
      maxHoldMinutes: numericOrNull(config.maxHoldMinutes),
      maxLosingHoldMinutes: numericOrNull(config.maxLosingHoldMinutes ?? 0),
      maxEntriesPerSignalWindow: resolveSignalWindowEntryLimit(config),
      cooldownAfterLossMinutes: numericOrNull(config.cooldownAfterLossMinutes),
      maxConsecutiveLosses: numericOrNull(config.maxConsecutiveLosses),
      lossCircuitBreakerCount: lossCircuitConfig.maxLosses,
      lossCircuitBreakerWindowMinutes: lossCircuitConfig.windowMinutes,
      lossCircuitBreakerCooldownMinutes: lossCircuitConfig.cooldownMinutes,
      investmentRatio: numericOrNull(this.investmentRatio ?? config.investmentRatio),
      tradingFee: numericOrNull(config.tradingFee ?? 0.0005),
      slippage: numericOrNull(config.slippage ?? 0.001),
      maxPositions: numericOrNull(this.maxPositions),
      entryDelayMinMs: numericOrNull(config.entryDelayMinMs),
      entryDelayMaxMs: numericOrNull(config.entryDelayMaxMs),
      maxRiskDataGapSeconds: numericOrNull(this.maxRiskDataGapSeconds),
      maxEntryRetracePercent: numericOrNull(config.maxEntryRetracePercent),
      maxEntryChasePercent: numericOrNull(config.maxEntryChasePercent),
      breakEvenTriggerPercent: numericOrNull(config.breakEvenTriggerPercent),
      breakEvenOffsetPercent: numericOrNull(config.breakEvenOffsetPercent),
      trailingActivationPercent: numericOrNull(config.trailingActivationPercent),
      trailingStopPercent: numericOrNull(config.trailingStopPercent),
      positionRiskCheckIntervalMs: numericOrNull(this.positionRiskCheckIntervalMs)
    };
  }

  comparePaperValidationConfig(recordedSnapshot) {
    if (!recordedSnapshot || typeof recordedSnapshot !== 'object') {
      return { consistent: null, drift: ['config_snapshot_missing'] };
    }

    const currentSnapshot = this.getPaperValidationConfigSnapshot();
    const backwardCompatibleDefaults = {
      maxEntriesPerSignalWindow: 0,
      maxRiskDataGapSeconds: this.isScalpingMode ? 30 : 0
    };
    const keys = new Set([
      ...Object.keys(recordedSnapshot),
      ...Object.keys(currentSnapshot)
    ]);
    const drift = [...keys]
      .sort()
      .filter(key => {
        const recordedValue = recordedSnapshot[key] === undefined &&
          Object.prototype.hasOwnProperty.call(backwardCompatibleDefaults, key)
          ? backwardCompatibleDefaults[key]
          : recordedSnapshot[key];
        return JSON.stringify(recordedValue) !== JSON.stringify(currentSnapshot[key]);
      });
    return {
      consistent: drift.length === 0,
      drift
    };
  }

  /**
   * Persist a strict DRY_RUN close so a process restart cannot erase the
   * forward validation trade count or realized P&L.
   */
  recordPaperStrictTrade(coin, trade, action = 'CLOSE') {
    if (!this.dryRun || !trade) return;
    if (!this.paperValidation?.active) {
      // The forward ledger is optional. Keep the runtime safety brake active
      // for ordinary DRY_RUN sessions even when no paper session is recording.
      this.registerRuntimeLoss(trade);
      return;
    }

    const exitTime = new Date(trade.exitTime || Date.now()).toISOString();
    const entryTime = trade.entryTime
      ? new Date(trade.entryTime).toISOString()
      : null;
    const ledgerKey = `${coin}:${trade.id ?? 'no-id'}:${exitTime}:${action}`;
    const strictTrades = Array.isArray(this.paperValidation.strictTrades)
      ? this.paperValidation.strictTrades
      : [];
    if (strictTrades.some(item => item.ledgerKey === ledgerKey)) return;

    strictTrades.push({
      ...trade,
      action,
      coin,
      entryTime,
      exitTime,
      ledgerKey
    });
    this.paperValidation.strictTrades = strictTrades.slice(-2000);
    this.registerRuntimeLoss({
      ...trade,
      exitTime
    });
    const strategy = this.strategies.get(coin);
    if (strategy) this.persistPaperStrategyRiskState(coin, strategy);
    // A strict risk-monitor close happens outside the normal analysis cycle.
    // Refresh the durable snapshot before saving so a crash/restart between
    // this close and the next cycle cannot resurrect the already-closed
    // position from a stale strictOpenPositions array.
    this.paperValidation.strictOpenPositions = this.getStrictOpenPositionSnapshot();
    this.savePaperValidation();
  }

  applyPaperStrategyRiskState(coin, strategy) {
    if (!strategy || !this.paperValidation?.strictRiskState) return;
    const riskState = this.paperValidation.strictRiskState;
    const cooldownUntil = Number(riskState.cooldownUntilByCoin?.[coin]);
    const consecutiveLosses = Number(riskState.consecutiveLossesByCoin?.[coin]);
    if (Number.isFinite(cooldownUntil)) strategy.cooldownUntil = cooldownUntil;
    if (Number.isFinite(consecutiveLosses)) strategy.consecutiveLosses = consecutiveLosses;
  }

  restorePaperStrategyRiskState() {
    if (!this.paperValidation?.strictRiskState) return;
    for (const [coin, strategy] of this.strategies.entries()) {
      this.applyPaperStrategyRiskState(coin, strategy);
    }
  }

  persistPaperStrategyRiskState(coin, strategy) {
    if (!this.paperValidation || !strategy) return;
    const riskState = this.paperValidation.strictRiskState || {
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      signalWindowEntryCountsByKey: {},
      lossCircuitBreaker: createLossCircuitBreakerState()
    };
    riskState.cooldownUntilByCoin = riskState.cooldownUntilByCoin || {};
    riskState.consecutiveLossesByCoin = riskState.consecutiveLossesByCoin || {};
    riskState.lossCircuitBreaker = riskState.lossCircuitBreaker || createLossCircuitBreakerState();
    riskState.cooldownUntilByCoin[coin] = Number(strategy.cooldownUntil) || 0;
    riskState.consecutiveLossesByCoin[coin] = Number(strategy.consecutiveLosses) || 0;
    this.paperValidation.strictRiskState = riskState;
  }

  getLossCircuitBreakerConfig() {
    return resolveLossCircuitBreakerConfig(this.config);
  }

  getStrictLossCircuitBreakerState() {
    if (this.dryRun && this.paperValidation) {
      const riskState = this.paperValidation.strictRiskState || {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      };
      riskState.lossCircuitBreaker = riskState.lossCircuitBreaker || createLossCircuitBreakerState();
      this.paperValidation.strictRiskState = riskState;
      return riskState.lossCircuitBreaker;
    }
    return this.lossCircuitBreaker;
  }

  getLossCircuitBreakerStatus(stateKey = 'strict') {
    let state = null;
    if (stateKey === 'strict') {
      state = this.getStrictLossCircuitBreakerState();
    } else {
      state = this.paperValidation?.[stateKey]?.lossCircuitBreaker || null;
    }
    return getLossCircuitBreakerStatus(state, Date.now(), this.getLossCircuitBreakerConfig());
  }

  isStrictEntryBlockedByLossCircuit(now = Date.now()) {
    return isLossCircuitCoolingDown(
      this.getStrictLossCircuitBreakerState(),
      now,
      this.getLossCircuitBreakerConfig()
    );
  }

  getStrictSignalWindowEntryCounts() {
    if (this.dryRun && this.paperValidation) {
      const riskState = this.paperValidation.strictRiskState || {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      };
      riskState.signalWindowEntryCountsByKey = normalizeSignalWindowEntryCounts(
        riskState.signalWindowEntryCountsByKey
      );
      this.paperValidation.strictRiskState = riskState;
      return riskState.signalWindowEntryCountsByKey;
    }

    if (!(this.runtimeSignalWindowEntryCounts instanceof Map)) {
      this.runtimeSignalWindowEntryCounts = new Map();
    }
    return Object.fromEntries(this.runtimeSignalWindowEntryCounts.entries());
  }

  getStrictSignalWindowEntryCount(signalKey) {
    if (!signalKey) return 0;
    const counts = this.getStrictSignalWindowEntryCounts();
    return Number(counts[String(signalKey)]) || 0;
  }

  isStrictEntryBlockedBySignalWindow(signalKey) {
    const limit = resolveSignalWindowEntryLimit(this.config);
    return limit > 0 && Boolean(signalKey) &&
      this.getStrictSignalWindowEntryCount(signalKey) >= limit;
  }

  recordStrictSignalWindowEntry(signalKey) {
    const limit = resolveSignalWindowEntryLimit(this.config);
    if (limit <= 0 || !signalKey) return;

    const normalizedKey = String(signalKey);
    if (this.dryRun && this.paperValidation) {
      const counts = this.getStrictSignalWindowEntryCounts();
      counts[normalizedKey] = (Number(counts[normalizedKey]) || 0) + 1;
      const trimmed = Object.entries(counts).slice(-2000);
      this.paperValidation.strictRiskState.signalWindowEntryCountsByKey = Object.fromEntries(trimmed);
      if (this.paperValidation.active) this.savePaperValidation();
      return;
    }

    const current = this.runtimeSignalWindowEntryCounts.get(normalizedKey) || 0;
    this.runtimeSignalWindowEntryCounts.set(normalizedKey, current + 1);
    while (this.runtimeSignalWindowEntryCounts.size > 2000) {
      const oldestKey = this.runtimeSignalWindowEntryCounts.keys().next().value;
      this.runtimeSignalWindowEntryCounts.delete(oldestKey);
    }
  }

  getStrictSignalWindowStatus() {
    const maxEntriesPerSignalWindow = resolveSignalWindowEntryLimit(this.config);
    const entries = Object.entries(this.getStrictSignalWindowEntryCounts());
    const [lastSignalKey, lastEntryCount] = entries.at(-1) || [];
    return {
      enabled: maxEntriesPerSignalWindow > 0,
      maxEntriesPerSignalWindow,
      lastSignalKey: lastSignalKey || null,
      lastEntryCount: Number(lastEntryCount) || 0,
      blockedEntries: Number(this.paperValidation?.telemetry?.signalWindowBlockedEntries) || 0
    };
  }

  registerRuntimeLoss(trade) {
    const profit = Number(trade?.profit);
    if (!trade || !Number.isFinite(profit) || profit >= 0) {
      return { triggered: false, lossCount: 0, cooldownUntil: 0 };
    }

    const state = this.getStrictLossCircuitBreakerState();
    const result = registerLoss(state, trade.exitTime || Date.now(), this.getLossCircuitBreakerConfig());
    if (result.triggered) {
      console.log(`\n🛑 전역 손실 회로차단기 발동: 최근 손실 ${result.lossCount}회 · ${this.getLossCircuitBreakerConfig().cooldownMinutes}분 신규 진입 차단`);
    }
    if (this.dryRun && this.paperValidation) {
      this.paperValidation.strictRiskState = this.paperValidation.strictRiskState || {};
      this.paperValidation.strictRiskState.lossCircuitBreaker = state;
    }
    return result;
  }

  async startPaperValidationSession(options = {}) {
    if (!this.dryRun) {
      throw new Error('실전 모드에서는 forward paper 세션을 시작할 수 없습니다.');
    }

    if (this.paperValidation?.active === false && this.paperValidation.endedWithOpenPositions === true &&
      options.reset !== true && options.allowUnsettledResume !== true) {
      const openCoins = (this.paperValidation.strictOpenPositions || [])
        .map(position => position.coin)
        .filter(Boolean)
        .join(', ');
      throw new Error(`이전 paper 세션이 strict 미청산 포지션(${openCoins || '확인 필요'})을 남긴 채 종료되었습니다. 새 시드 reset 또는 allowUnsettledResume=true를 명시하세요.`);
    }

    const shouldReset = options.reset === true;
    if (shouldReset) {
      const seedMoney = Number(options.seedMoney) > 0 ? Number(options.seedMoney) : this.initialSeedMoney;
      this.resetVirtualPortfolio(seedMoney);
    }

    const baselineAssets = await this.calculateTotalAssets();
    const startedAt = new Date().toISOString();
    this.riskMonitorState = createRiskMonitorState();
    this.paperValidation = {
      schemaVersion: 3,
      sessionId: `paper-${Date.now()}`,
      active: true,
      startedAt,
      endedAt: null,
      processId: process.pid,
      heartbeatAt: startedAt,
      strategyMode: this.strategyMode,
      strategyProfile: this.config.signalProfile || 'rsi_rebound',
      targetCoins: [...this.targetCoins],
      configSnapshot: this.getPaperValidationConfigSnapshot(),
      configSnapshotComplete: true,
      baselineAssets,
      baselineIncludesHoldings: this.virtualPortfolio.holdings.size > 0,
      thresholds: {
        minDays: Number(options.minDays) || this.config.paperValidationMinDays || 7,
        minTrades: Number(options.minTrades) || this.config.paperValidationMinTrades || 20,
        minReturnPercent: Number(options.minReturnPercent) || this.config.paperValidationMinReturnPercent || 0.2,
        maxDrawdownPercent: Number(options.maxDrawdownPercent) || this.config.paperValidationMaxDrawdownPercent || 15,
        maxHeartbeatGapMinutes: Number(options.maxHeartbeatGapMinutes) || this.config.paperValidationMaxHeartbeatGapMinutes || 15
      },
      interruptions: [],
      riskMonitor: { ...this.riskMonitorState },
      telemetry: {
        cycles: 0,
        buyCandidates: 0,
        candleFreshnessBlockedSnapshots: 0,
        candleFreshnessBlockedAnalyses: 0,
        candleFreshnessBlockedEntries: 0,
        candleFreshnessBlockReasons: {},
        candleFreshnessBlockedByCoin: {},
        candleFreshnessObservedByCoin: {},
        candleFreshnessAgeStatsByCoin: {},
        insufficientCandleDataByCoin: {},
        candleFreshnessBlockContexts: {
          analysis: 0,
          entry_confirmation: 0
        },
        candleFreshnessAgeStats: {
          sampleCount: 0,
          minAgeSeconds: null,
          maxObservedAgeSeconds: null,
          totalAgeSeconds: 0
        },
        lastCandleFreshnessBlock: null,
        circuitBlockedEntries: 0,
        signalWindowBlockedEntries: 0,
        shadowCircuitBlockedEntries: 0,
        looseShadowCircuitBlockedEntries: 0,
        marketRegimeBlockedEntries: 0,
        shadowMarketRegimeBlockedEntries: 0,
        looseShadowMarketRegimeBlockedEntries: 0,
        shadowCandidates: 0,
        sellSignals: 0,
        holdDecisions: 0,
        reasonCounts: {},
        rejectionCounts: {},
        shadowCandidatesByCoin: {},
        lastMarketRegime: null,
        lastCycleAt: null,
        lastBuyCandidateAt: null,
        requestStats: {
          batchTickerRequests: 0,
          individualTickerRequests: 0,
          candleRequests: 0,
          batchTickerFailures: 0
        }
      },
      // 청산 거래는 프로세스 재시작 후에도 forward 검증에 포함되어야
      // 하므로 strict paper 장부에 별도로 보존한다.
      strictTrades: [],
      strictRiskState: {
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        signalWindowEntryCountsByKey: {},
        lossCircuitBreaker: createLossCircuitBreakerState()
      },
      strictOpenPositions: [],
      // Strict paper trades are kept in the virtual portfolio. This separate
      // shadow book measures the relaxed candidate cohort without changing
      // that portfolio or affecting live-order eligibility.
      shadow: {
        positions: {},
        lastSignalByCoin: {},
        closedTrades: [],
        entryCount: 0,
        realizedProfit: 0,
        totalInvested: 0,
        winningTrades: 0,
        losingTrades: 0,
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        lossCircuitBreaker: createLossCircuitBreakerState(),
        lastEntryAt: null,
        lastExitAt: null
      },
      looseShadow: {
        positions: {},
        lastSignalByCoin: {},
        closedTrades: [],
        entryCount: 0,
        realizedProfit: 0,
        totalInvested: 0,
        winningTrades: 0,
        losingTrades: 0,
        cooldownUntilByCoin: {},
        consecutiveLossesByCoin: {},
        lossCircuitBreaker: createLossCircuitBreakerState(),
        lastEntryAt: null,
        lastExitAt: null
      },
      snapshots: [{ timestamp: startedAt, totalAssets: baselineAssets, reason: 'session_start' }]
    };
    this.savePaperValidation();
    return this.getPaperValidationStatus();
  }

  async stopPaperValidationSession() {
    if (!this.paperValidation) {
      return { available: false, active: false };
    }
    const strictOpenPositions = this.getStrictOpenPositionSnapshot();
    this.paperValidation.strictOpenPositions = strictOpenPositions;
    this.paperValidation.endedWithOpenPositions = strictOpenPositions.length > 0;
    this.paperValidation.stopReason = this.paperValidation.endedWithOpenPositions
      ? 'stopped_with_unsettled_strict_positions'
      : 'stopped_cleanly';
    this.paperValidation.active = false;
    this.paperValidation.endedAt = new Date().toISOString();
    this.savePaperValidation();
    return this.getPaperValidationStatus();
  }

  async recordPaperValidationSnapshot(reason = 'periodic') {
    if (!this.dryRun || !this.paperValidation?.active) return null;

    const now = Date.now();
    const lastSnapshot = this.paperValidation.snapshots?.at(-1);
    if (lastSnapshot && now - new Date(lastSnapshot.timestamp).getTime() < 60_000) {
      return this.getPaperValidationStatus();
    }

    const totalAssets = await this.calculateTotalAssets();
    this.paperValidation.snapshots = [
      ...(this.paperValidation.snapshots || []),
      { timestamp: new Date(now).toISOString(), totalAssets, reason }
    ].slice(-10000);
    this.savePaperValidation();
    return this.getPaperValidationStatus();
  }

  recordPaperSignalTelemetry(coinAnalyses = [], marketRegime = null) {
    if (!this.dryRun || !this.paperValidation?.active || !Array.isArray(coinAnalyses)) return;

    const telemetry = this.paperValidation.telemetry || {
      cycles: 0,
      buyCandidates: 0,
      candleFreshnessBlockedSnapshots: 0,
      candleFreshnessBlockedAnalyses: 0,
      candleFreshnessBlockedEntries: 0,
      candleFreshnessBlockReasons: {},
      candleFreshnessBlockedByCoin: {},
      candleFreshnessObservedByCoin: {},
      candleFreshnessAgeStatsByCoin: {},
      insufficientCandleDataByCoin: {},
      candleFreshnessBlockContexts: {
        analysis: 0,
        entry_confirmation: 0
      },
      candleFreshnessAgeStats: {
        sampleCount: 0,
        minAgeSeconds: null,
        maxObservedAgeSeconds: null,
        totalAgeSeconds: 0
      },
      lastCandleFreshnessBlock: null,
      circuitBlockedEntries: 0,
      signalWindowBlockedEntries: 0,
      shadowCircuitBlockedEntries: 0,
      looseShadowCircuitBlockedEntries: 0,
      marketRegimeBlockedEntries: 0,
      shadowMarketRegimeBlockedEntries: 0,
      looseShadowMarketRegimeBlockedEntries: 0,
      shadowCandidates: 0,
      sellSignals: 0,
      holdDecisions: 0,
      reasonCounts: {},
      rejectionCounts: {},
      shadowCandidatesByCoin: {},
      looseShadowCandidates: 0,
      looseShadowCandidatesByCoin: {},
      lastMarketRegime: null,
      lastCycleAt: null,
      lastBuyCandidateAt: null,
      requestStats: {
        batchTickerRequests: 0,
        individualTickerRequests: 0,
        candleRequests: 0,
        batchTickerFailures: 0
      }
    };
    telemetry.reasonCounts = telemetry.reasonCounts || {};
    telemetry.rejectionCounts = telemetry.rejectionCounts || {};
    telemetry.candleFreshnessBlockedSnapshots = Number(telemetry.candleFreshnessBlockedSnapshots) || 0;
    telemetry.candleFreshnessBlockedAnalyses = Number(telemetry.candleFreshnessBlockedAnalyses) || 0;
    telemetry.candleFreshnessBlockReasons = telemetry.candleFreshnessBlockReasons || {};
    telemetry.candleFreshnessBlockedByCoin = telemetry.candleFreshnessBlockedByCoin || {};
    telemetry.candleFreshnessObservedByCoin = telemetry.candleFreshnessObservedByCoin || {};
    telemetry.candleFreshnessAgeStatsByCoin = telemetry.candleFreshnessAgeStatsByCoin || {};
    telemetry.insufficientCandleDataByCoin = telemetry.insufficientCandleDataByCoin || {};
    telemetry.candleFreshnessBlockContexts = telemetry.candleFreshnessBlockContexts || {
      analysis: 0,
      entry_confirmation: 0
    };
    telemetry.candleFreshnessAgeStats = telemetry.candleFreshnessAgeStats || {
      sampleCount: 0,
      minAgeSeconds: null,
      maxObservedAgeSeconds: null,
      totalAgeSeconds: 0
    };
    telemetry.lastCandleFreshnessBlock = telemetry.lastCandleFreshnessBlock || null;
    telemetry.shadowCandidatesByCoin = telemetry.shadowCandidatesByCoin || {};
    telemetry.lastMarketRegime = telemetry.lastMarketRegime || null;
    telemetry.circuitBlockedEntries = Number(telemetry.circuitBlockedEntries) || 0;
    telemetry.candleFreshnessBlockedEntries = Number(telemetry.candleFreshnessBlockedEntries) || 0;
    telemetry.signalWindowBlockedEntries = Number(telemetry.signalWindowBlockedEntries) || 0;
    telemetry.shadowCircuitBlockedEntries = Number(telemetry.shadowCircuitBlockedEntries) || 0;
    telemetry.looseShadowCircuitBlockedEntries = Number(telemetry.looseShadowCircuitBlockedEntries) || 0;
    telemetry.marketRegimeBlockedEntries = Number(telemetry.marketRegimeBlockedEntries) || 0;
    telemetry.shadowMarketRegimeBlockedEntries = Number(telemetry.shadowMarketRegimeBlockedEntries) || 0;
    telemetry.looseShadowMarketRegimeBlockedEntries = Number(telemetry.looseShadowMarketRegimeBlockedEntries) || 0;
    telemetry.looseShadowCandidates = Number(telemetry.looseShadowCandidates) || 0;
    telemetry.looseShadowCandidatesByCoin = telemetry.looseShadowCandidatesByCoin || {};
    telemetry.requestStats = telemetry.requestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const requestStats = this.cycleRequestStats || {};
    for (const key of ['batchTickerRequests', 'individualTickerRequests', 'candleRequests', 'batchTickerFailures']) {
      telemetry.requestStats[key] = (Number(telemetry.requestStats[key]) || 0) + (Number(requestStats[key]) || 0);
    }
    this.cycleRequestStats = null;
    const now = new Date().toISOString();
    this.paperValidation.strictOpenPositions = this.getStrictOpenPositionSnapshot();
    telemetry.cycles += 1;
    telemetry.lastCycleAt = now;
    telemetry.heartbeatAt = now;
    this.paperValidation.heartbeatAt = now;
    if (marketRegime) telemetry.lastMarketRegime = marketRegime;

    for (const analysis of coinAnalyses) {
      const action = analysis?.decision?.action || 'HOLD';
      const coin = analysis?.coin || 'unknown';
      if (action === 'BUY') {
        telemetry.buyCandidates += 1;
        telemetry.lastBuyCandidateAt = now;
      } else if (action === 'SELL') {
        telemetry.sellSignals += 1;
      } else {
        telemetry.holdDecisions += 1;
      }

      const rebound = analysis?.decision?.details?.rebound;
      const candleFreshEnough = analysis?.candleFreshness?.valid !== false &&
        analysis?.decision?.details?.candleFreshness?.valid !== false;
      const regimeAllowsEntry = this.config.marketRegimeEnabled !== true ||
        analysis?.decision?.details?.marketRegime?.confirmed === true;
      for (const rejectionReason of rebound?.rejectionReasons || []) {
        telemetry.rejectionCounts[rejectionReason] =
          (telemetry.rejectionCounts[rejectionReason] || 0) + 1;
      }
      const shadowCandidate = candleFreshEnough && rebound?.available === true &&
        rebound.previousWasOversold === true &&
        rebound.bullishCandle === true &&
        Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= 0.1 &&
        Number(rebound.rsiRecovery) >= 1 &&
        regimeAllowsEntry;
      const looseShadowCandidate = candleFreshEnough && rebound?.available === true &&
        (rebound.previousWasOversold === true || rebound.currentWasOversold === true) &&
        rebound.bullishCandle === true &&
        Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= 0.05 &&
        Number(rebound.rsiRecovery) >= 0.5 &&
        regimeAllowsEntry;
      const shadowCandidateBeforeRegime = rebound?.available === true &&
        rebound.previousWasOversold === true &&
        rebound.bullishCandle === true &&
        Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= 0.1 &&
        Number(rebound.rsiRecovery) >= 1;
      const looseShadowCandidateBeforeRegime = rebound?.available === true &&
        (rebound.previousWasOversold === true || rebound.currentWasOversold === true) &&
        rebound.bullishCandle === true &&
        Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) >= 0.05 &&
        Number(rebound.rsiRecovery) >= 0.5;
      if (this.config.marketRegimeEnabled === true && !regimeAllowsEntry) {
        if (shadowCandidateBeforeRegime) telemetry.shadowMarketRegimeBlockedEntries += 1;
        if (looseShadowCandidateBeforeRegime) telemetry.looseShadowMarketRegimeBlockedEntries += 1;
      }
      if (shadowCandidate) {
        telemetry.shadowCandidates += 1;
        telemetry.shadowCandidatesByCoin[coin] = (telemetry.shadowCandidatesByCoin[coin] || 0) + 1;
      }
      if (looseShadowCandidate) {
        telemetry.looseShadowCandidates += 1;
        telemetry.looseShadowCandidatesByCoin[coin] =
          (telemetry.looseShadowCandidatesByCoin[coin] || 0) + 1;
      }

      const shadowResult = this.updatePaperShadowPosition(analysis, shadowCandidate && action !== 'BUY', now);
      const looseShadowResult = this.updatePaperShadowPosition(analysis, looseShadowCandidate && action !== 'BUY', now, 'looseShadow');
      if (shadowResult?.blockedByLossCircuit) telemetry.shadowCircuitBlockedEntries += 1;
      if (looseShadowResult?.blockedByLossCircuit) telemetry.looseShadowCircuitBlockedEntries += 1;

      const reason = String(analysis?.decision?.reason || 'unknown').slice(0, 120);
      telemetry.reasonCounts[reason] = (telemetry.reasonCounts[reason] || 0) + 1;
    }

    this.paperValidation.telemetry = telemetry;
    const lastPersistedAt = this.paperValidation.lastTelemetryPersistedAt
      ? new Date(this.paperValidation.lastTelemetryPersistedAt).getTime()
      : 0;
    if (Date.now() - lastPersistedAt >= 60_000) {
      this.paperValidation.lastTelemetryPersistedAt = now;
      this.savePaperValidation();
    }
  }

  recordPaperCircuitBlock() {
    if (!this.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.circuitBlockedEntries = (Number(telemetry.circuitBlockedEntries) || 0) + 1;
    telemetry.lastCircuitBlockedAt = new Date().toISOString();
    this.paperValidation.telemetry = telemetry;
  }

  recordPaperSignalWindowBlock() {
    if (!this.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.signalWindowBlockedEntries = (Number(telemetry.signalWindowBlockedEntries) || 0) + 1;
    telemetry.lastSignalWindowBlockedAt = new Date().toISOString();
    this.paperValidation.telemetry = telemetry;
  }

  recordPaperMarketRegimeBlock() {
    if (!this.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.marketRegimeBlockedEntries = (Number(telemetry.marketRegimeBlockedEntries) || 0) + 1;
    telemetry.lastMarketRegimeBlockedAt = new Date().toISOString();
    this.paperValidation.telemetry = telemetry;
  }

  recordInsufficientCandleData(coin, receivedCount, requiredCount) {
    if (!this.dryRun || !this.paperValidation?.active || !coin) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.insufficientCandleDataByCoin = telemetry.insufficientCandleDataByCoin || {};
    const current = telemetry.insufficientCandleDataByCoin[coin] || {
      count: 0,
      minReceivedCount: null,
      lastReceivedCount: null,
      requiredCount: null,
      lastAt: null
    };
    const received = Math.max(0, Number(receivedCount) || 0);
    const required = Math.max(1, Number(requiredCount) || 1);
    current.count = (Number(current.count) || 0) + 1;
    current.minReceivedCount = current.minReceivedCount === null
      ? received
      : Math.min(Number(current.minReceivedCount), received);
    current.lastReceivedCount = received;
    current.requiredCount = required;
    current.lastAt = new Date().toISOString();
    telemetry.insufficientCandleDataByCoin[coin] = current;
    this.paperValidation.telemetry = telemetry;
  }

  recordPaperCandleFreshnessObservation(coin, freshness) {
    if (!this.dryRun || !this.paperValidation?.active || !coin) return;
    const telemetry = this.paperValidation.telemetry || {};
    telemetry.candleFreshnessObservedByCoin = telemetry.candleFreshnessObservedByCoin || {};
    telemetry.candleFreshnessAgeStatsByCoin = telemetry.candleFreshnessAgeStatsByCoin || {};
    telemetry.candleFreshnessObservedByCoin[coin] =
      (Number(telemetry.candleFreshnessObservedByCoin[coin]) || 0) + 1;

    const stats = telemetry.candleFreshnessAgeStatsByCoin[coin] || {
      sampleCount: 0,
      validCount: 0,
      blockedCount: 0,
      missingTimestampCount: 0,
      minAgeSeconds: null,
      maxObservedAgeSeconds: null,
      totalAgeSeconds: 0
    };
    const ageSeconds = Number(freshness?.ageMs) / 1000;
    stats.sampleCount = (Number(stats.sampleCount) || 0) + 1;
    if (freshness?.valid === true) stats.validCount = (Number(stats.validCount) || 0) + 1;
    if (freshness?.reason === 'stale_candle_snapshot') {
      stats.blockedCount = (Number(stats.blockedCount) || 0) + 1;
    }
    if (freshness?.reason === 'missing_candle_timestamp') {
      stats.missingTimestampCount = (Number(stats.missingTimestampCount) || 0) + 1;
    }
    if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
      stats.minAgeSeconds = stats.minAgeSeconds === null
        ? ageSeconds
        : Math.min(Number(stats.minAgeSeconds), ageSeconds);
      stats.maxObservedAgeSeconds = stats.maxObservedAgeSeconds === null
        ? ageSeconds
        : Math.max(Number(stats.maxObservedAgeSeconds), ageSeconds);
      stats.totalAgeSeconds = (Number(stats.totalAgeSeconds) || 0) + ageSeconds;
    }
    telemetry.candleFreshnessAgeStatsByCoin[coin] = stats;
    this.paperValidation.telemetry = telemetry;
  }

  recordPaperCandleFreshnessBlock(reason = 'unknown', freshness = null, context = 'entry_confirmation', coin = null) {
    if (!this.dryRun || !this.paperValidation?.active) return;
    const telemetry = this.paperValidation.telemetry || {};
    const blockedAt = new Date().toISOString();
    const normalizedContext = context === 'analysis' ? 'analysis' : 'entry_confirmation';
    telemetry.candleFreshnessBlockedSnapshots = Number(telemetry.candleFreshnessBlockedSnapshots) || 0;
    telemetry.candleFreshnessBlockedAnalyses = Number(telemetry.candleFreshnessBlockedAnalyses) || 0;
    telemetry.candleFreshnessBlockedEntries = Number(telemetry.candleFreshnessBlockedEntries) || 0;
    telemetry.candleFreshnessBlockedSnapshots += 1;
    if (normalizedContext === 'analysis') {
      telemetry.candleFreshnessBlockedAnalyses += 1;
    } else {
      telemetry.candleFreshnessBlockedEntries += 1;
    }
    telemetry.candleFreshnessBlockContexts = telemetry.candleFreshnessBlockContexts || {
      analysis: 0,
      entry_confirmation: 0
    };
    telemetry.candleFreshnessBlockContexts[normalizedContext] =
      (Number(telemetry.candleFreshnessBlockContexts[normalizedContext]) || 0) + 1;
    telemetry.candleFreshnessBlockReasons = telemetry.candleFreshnessBlockReasons || {};
    telemetry.candleFreshnessBlockedByCoin = telemetry.candleFreshnessBlockedByCoin || {};
    telemetry.candleFreshnessAgeStats = telemetry.candleFreshnessAgeStats || {
      sampleCount: 0,
      minAgeSeconds: null,
      maxObservedAgeSeconds: null,
      totalAgeSeconds: 0
    };
    telemetry.candleFreshnessBlockReasons[reason] =
      (Number(telemetry.candleFreshnessBlockReasons[reason]) || 0) + 1;
    if (coin) {
      telemetry.candleFreshnessBlockedByCoin[coin] =
        (Number(telemetry.candleFreshnessBlockedByCoin[coin]) || 0) + 1;
    }
    telemetry.lastCandleFreshnessBlockAt = blockedAt;
    telemetry.lastCandleFreshnessBlock = {
      at: blockedAt,
      reason,
      context: normalizedContext,
      coin: coin || null,
      timestamp: freshness?.timestamp || null,
      source: freshness?.source || null,
      ageMs: Number.isFinite(Number(freshness?.ageMs)) ? Number(freshness.ageMs) : null,
      ageSeconds: Number.isFinite(Number(freshness?.ageMs))
        ? Number(freshness.ageMs) / 1000
        : null,
      maxAgeSeconds: Number.isFinite(Number(freshness?.maxAgeSeconds))
        ? Number(freshness.maxAgeSeconds)
        : this.maxCandleAgeSeconds
    };
    const ageSeconds = telemetry.lastCandleFreshnessBlock.ageSeconds;
    if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
      const ageStats = telemetry.candleFreshnessAgeStats;
      ageStats.sampleCount = (Number(ageStats.sampleCount) || 0) + 1;
      ageStats.minAgeSeconds = ageStats.minAgeSeconds === null
        ? ageSeconds
        : Math.min(Number(ageStats.minAgeSeconds), ageSeconds);
      ageStats.maxObservedAgeSeconds = ageStats.maxObservedAgeSeconds === null
        ? ageSeconds
        : Math.max(Number(ageStats.maxObservedAgeSeconds), ageSeconds);
      ageStats.totalAgeSeconds = (Number(ageStats.totalAgeSeconds) || 0) + ageSeconds;
    }
    this.paperValidation.telemetry = telemetry;
  }

  getStrictOpenPositionSnapshot() {
    return [...this.strategies.entries()]
      .filter(([, strategy]) => strategy?.currentPosition)
      .map(([coin, strategy]) => {
        const position = strategy.currentPosition;
        const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
        return {
          coin,
          entryPrice: Number(position.entryPrice) || null,
          amount: Number(position.amount) || null,
          entryTime: position.entryTime instanceof Date
            ? position.entryTime.toISOString()
            : position.entryTime || null,
          highestPrice: Number(position.highestPrice) || Number(position.entryPrice) || null,
          breakEvenArmed: position.breakEvenArmed === true,
          trailingArmed: position.trailingArmed === true,
          signalKey: position.signalKey || null,
          signalTime: position.signalTime || null,
          signalReferencePrice: numericOrNull(position.signalReferencePrice),
          signalReboundPercent: numericOrNull(position.signalReboundPercent),
          signalRsi: numericOrNull(position.signalRsi),
          signalOversoldRsi: numericOrNull(position.signalOversoldRsi),
          signalRsiRecovery: numericOrNull(position.signalRsiRecovery),
          signalVolumeRatio: numericOrNull(position.signalVolumeRatio),
          signalCloseStrength: numericOrNull(position.signalCloseStrength),
          signalTrendSlopePercent: numericOrNull(position.signalTrendSlopePercent),
          signalRangePercent: numericOrNull(position.signalRangePercent),
          entryDelayMs: numericOrNull(position.entryDelayMs),
          executionDriftPercent: numericOrNull(position.executionDriftPercent)
        };
      })
      .sort((a, b) => a.coin.localeCompare(b.coin));
  }

  /**
   * Relaxed shadow cohort for diagnosing filter starvation.
   *
   * This book is deliberately separate from the real virtual portfolio. It
   * enters on the observed ticker snapshot (plus adverse slippage), uses the
   * same stop/take/time limits, and never contributes to live promotion. Its
   * purpose is to answer whether rejected candidates are worth a new
   * holdout study instead of silently loosening production filters.
   */
  updatePaperShadowPosition(analysis, canEnter, timestamp, stateKey = 'shadow') {
    const result = {
      entered: false,
      closed: false,
      blockedByLossCircuit: false,
      circuitTriggered: false
    };
    if (!this.paperValidation?.active || !analysis?.coin) return result;

    const shadow = this.paperValidation[stateKey] || {
      positions: {},
      lastSignalByCoin: {},
      closedTrades: [],
      entryCount: 0,
      realizedProfit: 0,
      totalInvested: 0,
      winningTrades: 0,
      losingTrades: 0,
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      lossCircuitBreaker: createLossCircuitBreakerState(),
      lastEntryAt: null,
      lastExitAt: null
    };
    shadow.positions = shadow.positions || {};
    shadow.lastSignalByCoin = shadow.lastSignalByCoin || {};
    shadow.closedTrades = Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [];
    shadow.entryCount = Number(shadow.entryCount) || 0;
    shadow.realizedProfit = Number(shadow.realizedProfit) || 0;
    shadow.totalInvested = Number(shadow.totalInvested) || 0;
    shadow.winningTrades = Number(shadow.winningTrades) || 0;
    shadow.losingTrades = Number(shadow.losingTrades) || 0;
    shadow.cooldownUntilByCoin = shadow.cooldownUntilByCoin || {};
    shadow.consecutiveLossesByCoin = shadow.consecutiveLossesByCoin || {};
    shadow.lossCircuitBreaker = shadow.lossCircuitBreaker || createLossCircuitBreakerState();

    const coin = analysis.coin;
    const currentPrice = Number(analysis.currentPrice);
    const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      this.paperValidation[stateKey] = shadow;
      return result;
    }

    const tradingFee = Number.isFinite(Number(this.config.tradingFee))
      ? Number(this.config.tradingFee)
      : 0.0005;
    const slippage = Number.isFinite(Number(this.config.slippage))
      ? Number(this.config.slippage)
      : 0.001;
    const stopLossPercent = Number.isFinite(Number(this.config.stopLossPercent))
      ? Number(this.config.stopLossPercent)
      : 1.2;
    const takeProfitPercent = Number.isFinite(Number(this.config.takeProfitPercent))
      ? Number(this.config.takeProfitPercent)
      : 1.8;
    const maxHoldMinutes = Number.isFinite(Number(this.config.maxHoldMinutes))
      ? Number(this.config.maxHoldMinutes)
      : 30;
    const maxLosingHoldMinutes = Number.isFinite(Number(this.config.maxLosingHoldMinutes))
      ? Number(this.config.maxLosingHoldMinutes)
      : 0;
    const cooldownAfterLossMinutes = Number.isFinite(Number(this.config.cooldownAfterLossMinutes))
      ? Number(this.config.cooldownAfterLossMinutes)
      : 15;
    const maxConsecutiveLosses = Number.isFinite(Number(this.config.maxConsecutiveLosses))
      ? Number(this.config.maxConsecutiveLosses)
      : 3;
    const breakEvenTriggerPercent = Math.max(0, Number(this.config.breakEvenTriggerPercent) || 0);
    const configuredBreakEvenOffset = Number(this.config.breakEvenOffsetPercent);
    const breakEvenOffsetPercent = Number.isFinite(configuredBreakEvenOffset) && configuredBreakEvenOffset >= 0
      ? configuredBreakEvenOffset
      : 0.05;
    const trailingActivationPercent = Math.max(0, Number(this.config.trailingActivationPercent) || 0);
    const trailingStopPercent = Math.max(0, Number(this.config.trailingStopPercent) || 0);
    const nowMs = new Date(timestamp).getTime();
    const position = shadow.positions[coin];
    let closedThisCycle = false;

    if (position) {
      const entryTimestamp = new Date(position.entryTimestamp).getTime();
      const stopPrice = position.entryPrice * (1 - stopLossPercent / 100);
      const takePrice = position.entryPrice * (1 + takeProfitPercent / 100);
      position.highestPrice = Math.max(Number(position.highestPrice) || position.entryPrice, currentPrice);
      const gainPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (breakEvenTriggerPercent > 0 && gainPercent >= breakEvenTriggerPercent) {
        position.breakEvenArmed = true;
      }
      if (trailingActivationPercent > 0 && trailingStopPercent > 0 && gainPercent >= trailingActivationPercent) {
        position.trailingArmed = true;
      }
      let protectiveStopPrice = stopPrice;
      let protectiveType = 'STOP_LOSS';
      if (position.breakEvenArmed || position.trailingArmed) {
        const breakEvenStopPrice = calculateCostAdjustedBreakEvenPrice(position.entryPrice, {
          tradingFee,
          slippage,
          offsetPercent: breakEvenOffsetPercent
        });
        if (Number.isFinite(breakEvenStopPrice) && breakEvenStopPrice > protectiveStopPrice) {
          protectiveStopPrice = breakEvenStopPrice;
          protectiveType = 'BREAK_EVEN_STOP';
        }
      }
      if (position.trailingArmed) {
        const trailingStopPrice = position.highestPrice * (1 - trailingStopPercent / 100);
        if (trailingStopPrice > protectiveStopPrice) {
          protectiveStopPrice = trailingStopPrice;
          protectiveType = 'TRAILING_STOP';
        }
      }
      let exitReason = null;
      if (currentPrice <= protectiveStopPrice) exitReason = protectiveType;
      else if (currentPrice >= takePrice) exitReason = 'TAKE_PROFIT';
      else if (maxLosingHoldMinutes > 0 && Number.isFinite(entryTimestamp) &&
        nowMs - entryTimestamp >= maxLosingHoldMinutes * 60 * 1000 &&
        currentPrice <= position.entryPrice) {
        exitReason = 'MAX_LOSING_HOLD_TIME';
      }
      else if (maxHoldMinutes > 0 && Number.isFinite(entryTimestamp) &&
        nowMs - entryTimestamp >= maxHoldMinutes * 60 * 1000) {
        exitReason = 'MAX_HOLD_TIME';
      }

      if (exitReason) {
        const exitPrice = currentPrice * (1 - slippage);
        const grossAmount = position.amount * exitPrice;
        const sellFee = grossAmount * tradingFee;
        const netProfit = grossAmount - sellFee - position.investAmount;
        const closedTrade = {
          type: 'CLOSE',
          coin,
          reason: exitReason,
          entryPrice: position.entryPrice,
          exitPrice,
          amount: position.amount,
          investAmount: position.investAmount,
          netProfit,
          profitPercent: position.investAmount > 0 ? (netProfit / position.investAmount) * 100 : 0,
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: timestamp,
          signalKey: position.signalKey || null,
          signalTime: position.signalTime || null,
          signalReferencePrice: numericOrNull(position.signalReferencePrice),
          signalReboundPercent: numericOrNull(position.signalReboundPercent),
          signalRsi: numericOrNull(position.signalRsi),
          signalOversoldRsi: numericOrNull(position.signalOversoldRsi),
          signalRsiRecovery: numericOrNull(position.signalRsiRecovery),
          signalVolumeRatio: numericOrNull(position.signalVolumeRatio),
          signalCloseStrength: numericOrNull(position.signalCloseStrength),
          signalTrendSlopePercent: numericOrNull(position.signalTrendSlopePercent),
          signalRangePercent: numericOrNull(position.signalRangePercent),
          entryDelayMs: numericOrNull(position.entryDelayMs),
          executionDriftPercent: numericOrNull(position.executionDriftPercent),
          rejectionReasons: Array.isArray(position.rejectionReasons)
            ? position.rejectionReasons
            : []
        };
        shadow.closedTrades = [...shadow.closedTrades, closedTrade].slice(-1000);
        shadow.realizedProfit += netProfit;
        if (netProfit > 0) {
          shadow.winningTrades += 1;
          shadow.consecutiveLossesByCoin[coin] = 0;
          shadow.cooldownUntilByCoin[coin] = 0;
        } else {
          shadow.losingTrades += 1;
          const consecutiveLosses = (Number(shadow.consecutiveLossesByCoin[coin]) || 0) + 1;
          const cooldownMinutes = consecutiveLosses >= maxConsecutiveLosses
            ? Math.max(cooldownAfterLossMinutes, 60)
            : cooldownAfterLossMinutes;
          shadow.consecutiveLossesByCoin[coin] = consecutiveLosses;
          shadow.cooldownUntilByCoin[coin] = nowMs + cooldownMinutes * 60 * 1000;
        }
        shadow.lastExitAt = timestamp;
        delete shadow.positions[coin];
        closedThisCycle = true;
        result.closed = true;
        if (netProfit < 0) {
          const circuitResult = registerLoss(
            shadow.lossCircuitBreaker,
            nowMs,
            this.getLossCircuitBreakerConfig()
          );
          result.circuitTriggered = circuitResult.triggered;
        }
      }
    }

    if (!closedThisCycle && !shadow.positions[coin] && canEnter) {
      const rebound = analysis.decision?.details?.rebound;
      const signalKey = String(rebound?.signalKey || '');
      if (signalKey && shadow.lastSignalByCoin[coin] !== signalKey) {
        const cooldownUntil = Number(shadow.cooldownUntilByCoin[coin]) || 0;
        if (nowMs < cooldownUntil) {
          this.paperValidation[stateKey] = shadow;
          return result;
        }
        if ((Number(shadow.consecutiveLossesByCoin[coin]) || 0) >= maxConsecutiveLosses) {
          shadow.consecutiveLossesByCoin[coin] = 0;
          shadow.cooldownUntilByCoin[coin] = 0;
        }

        const activePositionCount = Object.keys(shadow.positions).length;
        const maxPositions = Number(this.maxPositions) || 3;
        if (activePositionCount < maxPositions) {
          if (isLossCircuitCoolingDown(
            shadow.lossCircuitBreaker,
            nowMs,
            this.getLossCircuitBreakerConfig()
          )) {
            result.blockedByLossCircuit = true;
            this.paperValidation[stateKey] = shadow;
            return result;
          }
          const baselineAssets = Number(this.paperValidation.baselineAssets) || this.initialSeedMoney;
          const investmentRatio = Number.isFinite(Number(this.investmentRatio))
            ? Number(this.investmentRatio)
            : 0.02;
          const investAmount = Math.min(baselineAssets * investmentRatio, baselineAssets * 0.95);
          const entryPrice = currentPrice * (1 + slippage);
          const buyFee = investAmount * tradingFee;
          const amount = (investAmount - buyFee) / entryPrice;
          if (investAmount >= this.MIN_ORDER_AMOUNT && amount > 0) {
            shadow.positions[coin] = {
              coin,
              entryPrice,
              amount,
              investAmount,
              entryTimestamp: timestamp,
              signalKey,
              signalTime: rebound.candleTime || null,
              signalReferencePrice: Number(rebound.referencePrice) || null,
              signalReboundPercent: Number(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent) || null,
              signalRsi: Number(rebound.rsi) || null,
              signalOversoldRsi: Number(rebound.oversoldRsi ?? rebound.previousRsi) || null,
              signalRsiRecovery: Number(rebound.rsiRecovery) || null,
              signalVolumeRatio: Number(rebound.volumeRatio) || null,
              signalCloseStrength: Number(rebound.closeStrength) || null,
              signalTrendSlopePercent: Number(rebound.trendSlopePercent) || null,
              signalRangePercent: Number(rebound.signalRangePercent) || null,
              entryDelayMs: Number(analysis.decision?.entryDelayMs) || null,
              executionDriftPercent: Number.isFinite(currentPrice) && Number(rebound.referencePrice) > 0
                ? ((currentPrice - Number(rebound.referencePrice)) / Number(rebound.referencePrice)) * 100
                : null,
              highestPrice: currentPrice,
              breakEvenArmed: false,
              trailingArmed: false,
              rejectionReasons: Array.isArray(rebound?.rejectionReasons)
                ? rebound.rejectionReasons.slice()
                : []
            };
            shadow.lastSignalByCoin[coin] = signalKey;
            shadow.entryCount += 1;
            shadow.totalInvested += investAmount;
            shadow.lastEntryAt = timestamp;
            result.entered = true;
          }
        }
      }
    }

    this.paperValidation[stateKey] = shadow;
    return result;
  }

  async getPaperValidationStatus() {
    const session = this.paperValidation;
    if (!session) {
      return {
        available: false,
        active: false,
        eligible: false,
        reason: 'paper_validation_session_not_started'
      };
    }

    const currentAssets = await this.calculateTotalAssets();
    const startedAtMs = new Date(session.startedAt).getTime();
    const elapsedDays = Math.max(0, (Date.now() - startedAtMs) / 86_400_000);
    const heartbeatAt = session.telemetry?.heartbeatAt || session.startedAt;
    const heartbeatAgeMs = Date.now() - new Date(heartbeatAt).getTime();
    const heartbeatLimitMs = Math.max(120_000, (Number(this.config.checkInterval) || 60_000) * 5);
    const ownerProcessAlive = this.isProcessAlive(session.processId);
    const orphaned = session.active === true &&
      (ownerProcessAlive === false || heartbeatAgeMs > heartbeatLimitMs);
    const configComparison = this.comparePaperValidationConfig(session.configSnapshot);
    const configSnapshotComplete = session.configSnapshotComplete === true;
    const snapshots = [
      { timestamp: session.startedAt, totalAssets: session.baselineAssets },
      ...(session.snapshots || [])
    ].filter(snapshot => Number.isFinite(Number(snapshot.totalAssets)));
    let peak = 0;
    let maxDrawdownPercent = 0;
    for (const snapshot of snapshots) {
      const assets = Number(snapshot.totalAssets);
      peak = Math.max(peak, assets);
      if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - assets) / peak) * 100);
    }

    const startedTrades = [];
    const startedAtTime = new Date(session.startedAt).getTime();
    const strictLedgerTrades = Array.isArray(session.strictTrades)
      ? session.strictTrades
      : [];
    const seenTradeKeys = new Set();
    for (const trade of strictLedgerTrades) {
      const exitTime = new Date(trade.exitTime || 0).getTime();
      const exitKey = Number.isFinite(exitTime) ? new Date(exitTime).toISOString() : String(trade.exitTime || '');
      const key = trade.ledgerKey || `${trade.coin || 'unknown'}:${trade.id || 'no-id'}:${exitKey}:${trade.action || 'CLOSE'}`;
      if ((trade.action === 'CLOSE' || trade.action === 'PARTIAL_CLOSE') &&
        exitTime >= startedAtTime && !seenTradeKeys.has(key)) {
        startedTrades.push(trade);
        seenTradeKeys.add(key);
      }
    }
    for (const [coin, strategy] of this.strategies.entries()) {
      for (const trade of strategy.tradeHistory || []) {
        const exitTime = new Date(trade.exitTime || 0).getTime();
        const exitKey = Number.isFinite(exitTime) ? new Date(exitTime).toISOString() : String(trade.exitTime || '');
        const key = trade.ledgerKey || `${coin}:${trade.id || 'no-id'}:${exitKey}:${trade.action || 'CLOSE'}`;
        if ((trade.action === 'CLOSE' || trade.action === 'PARTIAL_CLOSE') &&
          exitTime >= startedAtTime && !seenTradeKeys.has(key)) {
          trade.coin = trade.coin || coin;
          startedTrades.push(trade);
          seenTradeKeys.add(key);
        }
      }
    }

    const hasLiveStrategyState = this.strategies.size > 0;
    const strictOpenPositions = hasLiveStrategyState
      ? this.getStrictOpenPositionSnapshot()
      : (Array.isArray(session.strictOpenPositions) ? session.strictOpenPositions : []);

    const realizedProfit = startedTrades.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
    const shadow = session.shadow || {};
    const shadowClosedTrades = Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [];
    const shadowRealizedProfit = Number(shadow.realizedProfit) || 0;
    const shadowTotalInvested = Number(shadow.totalInvested) || 0;
    const shadowWinners = Number(shadow.winningTrades) || shadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const shadowLosers = Number(shadow.losingTrades) || shadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const shadowProfitFactor = shadowLosers > 0
      ? shadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(shadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : shadowWinners > 0 ? Infinity : 0;
    const looseShadow = session.looseShadow || {};
    const looseClosedTrades = Array.isArray(looseShadow.closedTrades) ? looseShadow.closedTrades : [];
    const looseRealizedProfit = Number(looseShadow.realizedProfit) || 0;
    const looseTotalInvested = Number(looseShadow.totalInvested) || 0;
    const looseWinners = Number(looseShadow.winningTrades) || looseClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const looseLosers = Number(looseShadow.losingTrades) || looseClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const looseProfitFactor = looseLosers > 0
      ? looseClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(looseClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : looseWinners > 0 ? Infinity : 0;
    const summarizeRejectionOutcomes = closedTrades => {
      const grouped = new Map();
      for (const trade of closedTrades) {
        for (const reason of Array.isArray(trade.rejectionReasons) ? trade.rejectionReasons : []) {
          const entry = grouped.get(reason) || {
            reason,
            tradeCount: 0,
            winningTrades: 0,
            losingTrades: 0,
            netProfit: 0
          };
          const netProfit = Number(trade.netProfit) || 0;
          entry.tradeCount += 1;
          entry.netProfit += netProfit;
          if (netProfit > 0) entry.winningTrades += 1;
          else entry.losingTrades += 1;
          grouped.set(reason, entry);
        }
      }
      return [...grouped.values()]
        .map(entry => ({
          ...entry,
          winRate: entry.tradeCount > 0 ? (entry.winningTrades / entry.tradeCount) * 100 : 0,
          profitFactor: entry.losingTrades > 0
            ? (closedTrades
              .filter(trade => Array.isArray(trade.rejectionReasons) && trade.rejectionReasons.includes(entry.reason) && Number(trade.netProfit) > 0)
              .reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
              Math.abs(closedTrades
                .filter(trade => Array.isArray(trade.rejectionReasons) && trade.rejectionReasons.includes(entry.reason) && Number(trade.netProfit) <= 0)
                .reduce((sum, trade) => sum + Number(trade.netProfit), 0)))
            : entry.winningTrades > 0 ? Infinity : 0
        }))
        .sort((a, b) => b.tradeCount - a.tradeCount || b.netProfit - a.netProfit);
    };
    const shadowRejectionOutcomes = summarizeRejectionOutcomes(shadowClosedTrades);
    const looseRejectionOutcomes = summarizeRejectionOutcomes(looseClosedTrades);
    const strictLossCircuitBreaker = this.getLossCircuitBreakerStatus('strict');
    const shadowLossCircuitBreaker = this.getLossCircuitBreakerStatus('shadow');
    const looseShadowLossCircuitBreaker = this.getLossCircuitBreakerStatus('looseShadow');
    const baselineAssets = Number(session.baselineAssets) || 0;
    const returnPercent = baselineAssets > 0 ? ((currentAssets / baselineAssets) - 1) * 100 : 0;
    const thresholds = session.thresholds || {};
    const interruptions = Array.isArray(session.interruptions) ? session.interruptions : [];
    const maxHeartbeatGapMinutes = Number(thresholds.maxHeartbeatGapMinutes) || 15;
    const maxAllowedHeartbeatGapMs = maxHeartbeatGapMinutes * 60 * 1000;
    const continuityEligible = interruptions.every(interruption =>
      Number(interruption.gapMs) <= maxAllowedHeartbeatGapMs
    );
    const riskMonitor = this.getRiskMonitorStatus();
    const eligible = !orphaned &&
      continuityEligible &&
      riskMonitor.continuityEligible &&
      configSnapshotComplete &&
      configComparison.consistent === true &&
      elapsedDays >= (Number(thresholds.minDays) || 7) &&
      startedTrades.length >= (Number(thresholds.minTrades) || 20) &&
      returnPercent >= (Number(thresholds.minReturnPercent) || 0.2) &&
      maxDrawdownPercent <= (Number(thresholds.maxDrawdownPercent) || 15);
    const telemetry = session.telemetry || null;
    const filterStarvation = Boolean(telemetry && telemetry.cycles >= 20 && telemetry.buyCandidates === 0);
    const suggestedAdjustments = [];
    if (filterStarvation) {
      const reasonCounts = telemetry.reasonCounts || {};
      const reasonText = Object.keys(reasonCounts).join(' ');
      const rejectionCounts = telemetry.rejectionCounts || {};
      const rejectionSuggestions = {
        previous_rsi_not_oversold: 'oversoldLookback=3 후보를 별도 holdout 검증',
        volume_confirmation_failed: 'minVolumeRatio=0.8 후보를 별도 holdout 검증',
        price_rebound_below_threshold: 'minReboundPercent=0.10 후보를 별도 holdout 검증',
        previous_high_break_failed: '직전 고가 돌파 필터 유지/완화 프로파일을 병렬 비교',
        rsi_recovery_below_threshold: 'minRsiRecovery=1 후보를 별도 holdout 검증',
        close_strength_failed: 'minCloseStrength=0.55 후보를 별도 holdout 검증',
        trend_filter_failed: 'minTrendSlopePercent=-0.5 후보를 별도 holdout 검증',
        signal_range_too_narrow: 'minSignalRangePercent=0.2/0.4 후보를 별도 holdout 검증'
      };
      const keepFilterSuggestions = {
        previous_rsi_not_oversold: '현재 RSI 과매도 필터 유지',
        volume_confirmation_failed: 'minVolumeRatio=1.0 필터 유지',
        price_rebound_below_threshold: 'minReboundPercent=0.15 필터 유지',
        previous_high_break_failed: '직전 고가 돌파 필터 유지',
        rsi_recovery_below_threshold: 'minRsiRecovery=2 필터 유지',
        close_strength_failed: 'minCloseStrength=0.65 필터 유지',
        trend_filter_failed: 'minTrendSlopePercent=-0.2 필터 유지',
        signal_range_too_narrow: '신호 변동폭 하한은 별도 검증 전 비활성 유지'
      };
      const shadowOutcomeByReason = new Map(
        shadowRejectionOutcomes.map(outcome => [outcome.reason, outcome])
      );
      const rankedRejections = Object.entries(rejectionCounts)
        .sort((a, b) => b[1] - a[1]);
      const outcomeBackedRejections = rankedRejections
        .filter(([reason]) => {
          const outcome = shadowOutcomeByReason.get(reason);
          return outcome?.tradeCount >= 3 && outcome.netProfit < 0;
        });
      const reasonsToSuggest = [
        ...outcomeBackedRejections,
        ...rankedRejections
      ].filter(([reason], index, entries) => entries.findIndex(([candidate]) => candidate === reason) === index)
        .slice(0, 3);
      reasonsToSuggest
        .forEach(([reason, count]) => {
          const outcome = shadowOutcomeByReason.get(reason);
          if (outcome?.tradeCount >= 3 && outcome.netProfit < 0) {
            suggestedAdjustments.push(`${keepFilterSuggestions[reason] || reason} · shadow ${outcome.tradeCount}회 손익 ${outcome.netProfit.toFixed(2)}원/PF ${Number.isFinite(outcome.profitFactor) ? outcome.profitFactor.toFixed(2) : '∞'} → 완화 금지 (${count}회 거절)`);
          } else if (rejectionSuggestions[reason]) {
            suggestedAdjustments.push(`${rejectionSuggestions[reason]} (${count}회)`);
          }
        });
      if (suggestedAdjustments.length === 0 && reasonText.includes('최소 반등률')) {
        suggestedAdjustments.push('다음 홀드아웃에서 minReboundPercent=0.10 후보를 별도 검증');
      }
      if (suggestedAdjustments.length === 0 && reasonText.includes('거래량')) {
        suggestedAdjustments.push('다음 홀드아웃에서 minVolumeRatio=0.8 후보를 별도 검증');
      }
      if (suggestedAdjustments.length === 0 && reasonText.includes('고가 돌파')) {
        suggestedAdjustments.push('직전 고가 돌파 필터를 유지/완화한 두 프로파일을 병렬 비교');
      }
      if (suggestedAdjustments.length === 0) {
        suggestedAdjustments.push('현재 시장에는 유효한 반등 후보가 없음; 파라미터 자동 완화 금지');
      }
    }

    return {
      available: true,
      active: session.active === true && !orphaned,
      eligible,
      state: eligible ? 'PASS' : session.active === false || orphaned ? 'STOPPED' : 'RUNNING',
      orphaned,
      sessionId: session.sessionId,
      strategyMode: session.strategyMode,
      strategyProfile: session.strategyProfile,
      configSnapshot: session.configSnapshot || null,
      configConsistent: configComparison.consistent,
      configDrift: configComparison.drift,
      configSnapshotComplete,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      processId: session.processId || null,
      processAlive: ownerProcessAlive,
      elapsedDays,
      baselineAssets,
      currentAssets,
      returnPercent,
      realizedProfit,
      closedTradeCount: startedTrades.length,
      maxDrawdownPercent,
      baselineIncludesHoldings: session.baselineIncludesHoldings === true,
      endedWithOpenPositions: session.endedWithOpenPositions === true,
      stopReason: session.stopReason || null,
      thresholds,
      snapshotCount: snapshots.length,
      lastSnapshotAt: snapshots.at(-1)?.timestamp || session.startedAt,
      strictLedgerTradeCount: strictLedgerTrades.length,
      strictRiskState: session.strictRiskState || null,
      signalWindow: this.getStrictSignalWindowStatus(),
      lossCircuitBreaker: strictLossCircuitBreaker,
      strictEvaluation: {
        activePositions: strictOpenPositions.length,
        positions: strictOpenPositions,
        lossCircuitBreaker: strictLossCircuitBreaker,
        note: '현재 프로세스의 strict 전략 포지션 snapshot입니다. 청산 전 손익은 currentAssets/returnPercent에 평가손익으로 반영됩니다.'
      },
      heartbeatAt,
      heartbeatAgeMs,
      continuityEligible,
      riskMonitor,
      interruptionCount: interruptions.length,
      maxInterruptionMinutes: interruptions.length > 0
        ? Math.max(...interruptions.map(interruption => Number(interruption.gapMs) || 0)) / 60000
        : 0,
      storage: this.getStorageStatus(),
      candleFreshness: {
        maxAgeSeconds: this.maxCandleAgeSeconds,
        blockedSnapshots: Number(telemetry?.candleFreshnessBlockedSnapshots) || 0,
        blockedAnalyses: Number(telemetry?.candleFreshnessBlockedAnalyses) || 0,
        blockedEntries: Number(telemetry?.candleFreshnessBlockedEntries) || 0,
        blockReasons: telemetry?.candleFreshnessBlockReasons || {},
        blockedByCoin: telemetry?.candleFreshnessBlockedByCoin || {},
        observedByCoin: telemetry?.candleFreshnessObservedByCoin || {},
        ageStatsByCoin: Object.fromEntries(
          Object.entries(telemetry?.candleFreshnessAgeStatsByCoin || {})
            .map(([coin, ageStats]) => {
              const sampleCount = Number(ageStats?.sampleCount) || 0;
              return [coin, {
                sampleCount,
                validCount: Number(ageStats?.validCount) || 0,
                blockedCount: Number(ageStats?.blockedCount) || 0,
                missingTimestampCount: Number(ageStats?.missingTimestampCount) || 0,
                minAgeSeconds: Number.isFinite(Number(ageStats?.minAgeSeconds))
                  ? Number(ageStats.minAgeSeconds)
                  : null,
                maxObservedAgeSeconds: Number.isFinite(Number(ageStats?.maxObservedAgeSeconds))
                  ? Number(ageStats.maxObservedAgeSeconds)
                  : null,
                averageAgeSeconds: sampleCount > 0
                  ? (Number(ageStats?.totalAgeSeconds) || 0) / sampleCount
                  : null
              }];
            })
        ),
        blockContexts: telemetry?.candleFreshnessBlockContexts || {},
        ageStats: (() => {
          const ageStats = telemetry?.candleFreshnessAgeStats || {};
          const sampleCount = Number(ageStats.sampleCount) || 0;
          return {
            sampleCount,
            minAgeSeconds: Number.isFinite(Number(ageStats.minAgeSeconds))
              ? Number(ageStats.minAgeSeconds)
              : null,
            maxObservedAgeSeconds: Number.isFinite(Number(ageStats.maxObservedAgeSeconds))
              ? Number(ageStats.maxObservedAgeSeconds)
              : null,
            averageAgeSeconds: sampleCount > 0
              ? (Number(ageStats.totalAgeSeconds) || 0) / sampleCount
              : null
          };
        })(),
        lastBlock: telemetry?.lastCandleFreshnessBlock || null
      },
      candleDataQuality: {
        insufficientByCoin: telemetry?.insufficientCandleDataByCoin || {},
        minimumCandleCount: Math.max(50, (Number(this.config?.rsiPeriod) || 14) + 10)
      },
      telemetry,
      shadowEvaluation: {
        activePositions: Object.keys(shadow.positions || {}).length,
        entryCount: Number(shadow.entryCount) || 0,
        closedTradeCount: shadowClosedTrades.length,
        realizedProfit: shadowRealizedProfit,
        realizedReturnPercent: shadowTotalInvested > 0 ? (shadowRealizedProfit / shadowTotalInvested) * 100 : 0,
        winningTrades: shadowWinners,
        losingTrades: shadowLosers,
        winRate: shadowClosedTrades.length > 0 ? (shadowWinners / shadowClosedTrades.length) * 100 : 0,
        profitFactor: shadowProfitFactor,
        lossCircuitBreaker: shadowLossCircuitBreaker,
        rejectionOutcomes: shadowRejectionOutcomes,
        lastEntryAt: shadow.lastEntryAt || null,
        lastExitAt: shadow.lastExitAt || null,
        note: 'soft 후보를 별도 가상 장부로 추적한 참고치이며 strict paper 자산과 실전 승격 판정에는 포함하지 않습니다.'
      },
      looseShadowEvaluation: {
        activePositions: Object.keys(looseShadow.positions || {}).length,
        entryCount: Number(looseShadow.entryCount) || 0,
        closedTradeCount: looseClosedTrades.length,
        realizedProfit: looseRealizedProfit,
        realizedReturnPercent: looseTotalInvested > 0 ? (looseRealizedProfit / looseTotalInvested) * 100 : 0,
        winningTrades: looseWinners,
        losingTrades: looseLosers,
        winRate: looseClosedTrades.length > 0 ? (looseWinners / looseClosedTrades.length) * 100 : 0,
        profitFactor: looseProfitFactor,
        lossCircuitBreaker: looseShadowLossCircuitBreaker,
        rejectionOutcomes: looseRejectionOutcomes,
        lastEntryAt: looseShadow.lastEntryAt || null,
        lastExitAt: looseShadow.lastExitAt || null,
        note: '더 완화된 후보를 별도 추적한 진단용 장부이며 strict paper 자산·승격 판정에 포함하지 않습니다.'
      },
      filterStarvation,
      suggestedAdjustments
    };
  }

  /**
   * 다중 코인 자동매매 시작
   */
  async start() {
    this.assertLiveValidationGate();
    this._stopRequested = false;
    console.log(`\n🚀 ${this.isScalpingMode ? '과매도 반응 스캘핑' : '다중 코인'} 자동매매 시스템 시작`);
    console.log(`모드: ${this.dryRun ? '모의투자' : '실전투자'}`);

    console.log(`분석 대상: ${this.targetCoins.length}개 코인`);

    console.log(`포지션 제한: ${this.maxPositions}개`);

    // 투자 비율 표시
    console.log(`투자 비율: 총자산의 ${(this.investmentRatio * 100).toFixed(1)}% (최소 ${this.MIN_ORDER_AMOUNT.toLocaleString()}원)`);

    // 실전 모드: 초기 시드머니 자동 기록 (최초 1회)
    if (!this.dryRun && this.initialSeedMoney === 0) {
      await this.saveInitialSeedMoney();
    }

    // 초기 시드머니 표시
    if (this.initialSeedMoney > 0) {
      console.log(`초기 시드머니: ${this.initialSeedMoney.toLocaleString()}원`);
    }

    console.log('─'.repeat(80));

    this.isRunning = true;
    this.startPositionRiskMonitor();

    // 스캘핑은 뉴스 수집 지연과 장기 감성을 매수 조건에서 제외한다.
    if (this.useNews) {
      await this.updateNews();
    } else {
      this.newsData = null;
      console.log('🧭 스캘핑 모드: 뉴스 분석 없이 가격 반등만 감시합니다.');
    }

    // 주기적 실행
    while (this.isRunning) {
      try {
        await this.executeTradingCycle();
        await this.recordPaperValidationSnapshot('trading_cycle');
        await this.sleep(this.config.checkInterval || 60000);
      } catch (error) {
        console.error('\n❌ 매매 사이클 오류:', error.message);
        await this.sleep(10000);
      }
    }
  }

  /**
   * 스캘핑 실전 주문은 읽기 전용 워크포워드 검증이 전체 마켓에서
   * 통과하기 전까지 시작하지 않는다. DRY_RUN에는 적용하지 않는다.
   */
  assertLiveValidationGate() {
    if (this.dryRun || !this.isScalpingMode || this.config.requireValidationPassForLive === false) {
      return;
    }

    const reportFile = 'scalping_validation.json';
    if (!fs.existsSync(reportFile)) {
      throw new Error('실전 스캘핑 차단: scalping_validation.json 검증 리포트가 없습니다. 먼저 npm run validate:scalping을 실행하세요.');
    }

    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (error) {
      throw new Error(`실전 스캘핑 차단: 검증 리포트를 읽을 수 없습니다 (${error.message})`);
    }

    this.validatePromotionReport(report);
  }

  validatePromotionReport(report) {
    if (!report || report.validationMode !== 'fixed_config') {
      throw new Error('실전 스캘핑 차단: 현재 runtime 설정을 고정 검증한 fixed_config 리포트가 필요합니다. tuned 리포트는 live 승격에 사용할 수 없습니다.');
    }
    if (report.strategyMode !== this.strategyMode) {
      throw new Error(`실전 스캘핑 차단: validation report 전략 모드가 다릅니다 (${report.strategyMode || 'unknown'}).`);
    }
    if (!Array.isArray(report.markets) || report.markets.length === 0) {
      throw new Error('실전 스캘핑 차단: 검증 대상 market 목록이 비어 있습니다.');
    }

    const currentSnapshot = this.getPaperValidationConfigSnapshot();
    const comparableKeys = [
      'signalProfile',
      'candleUnit',
      'rsiPeriod',
      'rsiOversold',
      'rsiOverbought',
      'oversoldLookback',
      'minReboundPercent',
      'minRsiRecovery',
      'minVolumeRatio',
      'volumeLookback',
      'minCloseStrength',
      'trendPeriod',
      'trendSlopeLookback',
      'minTrendSlopePercent',
      'requirePreviousHighBreak',
      'maxSignalRangePercent',
      'minSignalRangePercent',
      'marketRegimeEnabled',
      'marketRegimeLookback',
      'marketRegimeMinBreadth',
      'marketRegimeMinReturnPercent',
      'requireReboundBelowOverbought',
      'stopLossPercent',
      'takeProfitPercent',
      'maxHoldMinutes',
      'maxLosingHoldMinutes',
      'maxEntriesPerSignalWindow',
      'breakEvenTriggerPercent',
      'breakEvenOffsetPercent',
      'trailingActivationPercent',
      'trailingStopPercent',
      'cooldownAfterLossMinutes',
      'maxConsecutiveLosses',
      'lossCircuitBreakerCount',
      'lossCircuitBreakerWindowMinutes',
      'lossCircuitBreakerCooldownMinutes',
      'investmentRatio',
      'tradingFee',
      'slippage',
      'entryDelayMinMs',
      'entryDelayMaxMs',
      'maxRiskDataGapSeconds',
      'maxEntryRetracePercent',
      'maxEntryChasePercent',
      'maxCandleAgeSeconds'
    ];
    const reportConfig = report.config || {};
    const backwardCompatibleReportDefaults = {
      maxRiskDataGapSeconds: 30
    };
    const missingKeys = comparableKeys.filter(key =>
      reportConfig[key] === undefined &&
      !Object.prototype.hasOwnProperty.call(backwardCompatibleReportDefaults, key)
    );
    if (missingKeys.length > 0) {
      throw new Error(`실전 스캘핑 차단: fixed validation report 설정이 불완전합니다 (${missingKeys.join(', ')}).`);
    }
    const configDrift = comparableKeys
      .filter(key => {
        const reportValue = reportConfig[key] === undefined &&
          Object.prototype.hasOwnProperty.call(backwardCompatibleReportDefaults, key)
          ? backwardCompatibleReportDefaults[key]
          : reportConfig[key];
        return JSON.stringify(reportValue) !== JSON.stringify(currentSnapshot[key]);
      });
    if (configDrift.length > 0) {
      throw new Error(`실전 스캘핑 차단: validation report와 현재 runtime 설정이 다릅니다 (${configDrift.join(', ')}). fixed validation을 다시 실행하세요.`);
    }

    if (report.promoted !== true) {
      const promoted = Array.isArray(report.promotedMarkets) ? report.promotedMarkets.length : 0;
      const total = Array.isArray(report.markets) ? report.markets.length : 0;
      throw new Error(`실전 스캘핑 차단: 전체 워크포워드 게이트 미통과 (${promoted}/${total}). DRY_RUN=true로 계속 검증하세요.`);
    }
  }

  /**
   * 중지
   */
  syncRiskMonitorState() {
    if (!this.paperValidation) return;
    this.paperValidation.riskMonitor = { ...this.riskMonitorState };
    this.paperValidation.telemetry = this.paperValidation.telemetry || {};
    this.paperValidation.telemetry.riskMonitor = { ...this.riskMonitorState };
  }

  getRiskMonitorStatus(now = Date.now()) {
    return getRiskMonitorStatus(
      this.riskMonitorState,
      now,
      this.maxRiskDataGapSeconds
    );
  }

  recordRiskMonitorSuccess(now = Date.now()) {
    this.riskMonitorState = recordRiskMonitorSuccess(this.riskMonitorState, now);
    this.syncRiskMonitorState();
    return this.getRiskMonitorStatus(now);
  }

  recordRiskMonitorFailure(error, now = Date.now()) {
    const result = recordRiskMonitorFailure(
      this.riskMonitorState,
      error,
      now,
      this.maxRiskDataGapSeconds
    );
    this.riskMonitorState = result.state;
    this.syncRiskMonitorState();
    if (this.dryRun && this.paperValidation?.active) this.savePaperValidation();
    return {
      ...result,
      status: this.getRiskMonitorStatus(now)
    };
  }

  /**
   * An open position without a successful ticker check is not valid forward
   * evidence. Once the outage budget is exceeded, stop the loop so it cannot
   * keep accepting new entries while its exits are unknowable.
   */
  handleRiskMonitorFailure(error) {
    const result = this.recordRiskMonitorFailure(error);
    if (result.failClosed && this.isRunning) {
      console.error(`\n🛑 리스크 시세 공백 ${result.outageDurationSeconds.toFixed(1)}초 초과 - 신규 매매와 paper 관찰을 중지합니다.`);
      this.stop();
    }
    return result;
  }

  stop() {
    console.log('\n⏹️  다중 코인 자동매매 시스템 중지');
    this._stopRequested = true;
    this.isRunning = false;
    this.stopPositionRiskMonitor();
  }

  startPositionRiskMonitor() {
    if (this.positionRiskTimer || this.positionRiskCheckIntervalMs <= 0) return;
    this.positionRiskTimer = setInterval(() => {
      this.monitorOpenPositions().catch(error => {
        console.error(`\n❌ 포지션 리스크 모니터 오류: ${error.message}`);
      });
    }, this.positionRiskCheckIntervalMs);
  }

  stopPositionRiskMonitor() {
    if (!this.positionRiskTimer) return;
    clearInterval(this.positionRiskTimer);
    this.positionRiskTimer = null;
  }

  async monitorOpenPositions() {
    if (!this.isRunning || this._riskCheckInProgress || this._orderInProgress) return;

    const strictPositions = [...this.strategies.entries()]
      .filter(([, strategy]) => strategy?.currentPosition)
      .map(([coin, strategy]) => ({ coin, strategy }));
    const shadowStates = this.dryRun && this.paperValidation?.active
      ? ['shadow', 'looseShadow']
        .map(stateKey => ({ stateKey, book: this.paperValidation[stateKey] }))
        .filter(({ book }) => book?.positions && Object.keys(book.positions).length > 0)
      : [];
    const shadowCoins = shadowStates.flatMap(({ book }) => Object.keys(book.positions));
    const monitoredCoins = [...new Set([
      ...strictPositions.map(position => position.coin),
      ...shadowCoins
    ])];
    if (monitoredCoins.length === 0) return;

    this._riskCheckInProgress = true;
    try {
      const tickers = await this.riskUpbit.getTicker(monitoredCoins);
      const priceMap = new Map(
        (Array.isArray(tickers) ? tickers : [])
          .filter(ticker => ticker?.market && Number.isFinite(Number(ticker.trade_price)))
          .map(ticker => [ticker.market, Number(ticker.trade_price)])
      );
      if (priceMap.size < monitoredCoins.length) {
        const missingCoins = monitoredCoins.filter(coin => !priceMap.has(coin));
        const error = new Error(`risk ticker 응답 불완전 (${missingCoins.join(', ') || 'unknown'})`);
        error.code = 'INCOMPLETE_RISK_TICKER';
        throw error;
      }
      this.recordRiskMonitorSuccess();
      if (priceMap.size === 0 || !this.isRunning) return;

      if (strictPositions.length > 0) {
        const accounts = await this.getAccountInfo();
        let currentPositions = this.getCurrentPositionCount();
        for (const { coin, strategy } of strictPositions) {
          if (!this.isRunning || this._orderInProgress) break;
          const currentPrice = priceMap.get(coin);
          if (!Number.isFinite(currentPrice) || !strategy.currentPosition) continue;

          const positionCheck = strategy.checkPosition(currentPrice);
          if (!positionCheck.shouldClose) continue;

          await this.executeOrder(
            coin,
            {
              action: 'SELL',
              reason: positionCheck.reason,
              confidence: '1.00',
              signalStrength: { level: 'STRONG', multiplier: 1, score: 100 },
              scores: { technical: '0.00', news: '50.00', total: '0.00' },
              details: { positionCheck, source: 'position_risk_monitor' }
            },
            currentPrice,
            this.getKRWBalance(accounts),
            this.getCoinBalance(accounts, coin),
            currentPositions,
            []
          );
          currentPositions = this.getCurrentPositionCount();
        }
      }

      if (shadowStates.length > 0 && this.isRunning) {
        const timestamp = new Date().toISOString();
        let shadowClosed = false;
        for (const { stateKey, book } of shadowStates) {
          for (const coin of Object.keys(book.positions || {})) {
            const currentPrice = priceMap.get(coin);
            if (!Number.isFinite(currentPrice)) continue;
            const closedBefore = book.closedTrades?.length || 0;
            this.updatePaperShadowPosition(
              { coin, currentPrice, decision: { details: { rebound: null } } },
              false,
              timestamp,
              stateKey
            );
            if ((this.paperValidation[stateKey]?.closedTrades?.length || 0) > closedBefore) {
              shadowClosed = true;
            }
          }
        }
        if (shadowClosed) this.savePaperValidation();
      }
    } catch (error) {
      const result = this.handleRiskMonitorFailure(error);
      console.error(`\n⚠️  포지션 리스크 조회 실패: ${error.message} (연속 ${result.status.consecutiveFailures}회, outage ${result.status.currentOutageDurationSeconds.toFixed(1)}초)`);
    } finally {
      this._riskCheckInProgress = false;
    }
  }

  /**
   * 실전 모드: 거래소 실제 잔고와 내부 상태 동기화
   * 주문 후 실제 체결 결과와 내부 포지션 상태 불일치 방지
   */
  async syncWithExchange() {
    if (this.dryRun) return; // 모의투자는 동기화 불필요

    try {
      console.log(`\n🔄 거래소 잔고 동기화 중...`);

      const accounts = await this.upbit.getAccounts();
      const exchangeHoldings = new Map();

      // 거래소 실제 보유량 수집
      for (const acc of accounts) {
        if (acc.currency === 'KRW') continue;

        const balance = parseFloat(acc.balance || 0);
        const locked = parseFloat(acc.locked || 0);
        const totalBalance = balance + locked;

        if (totalBalance > 0) {
          const market = `KRW-${acc.currency}`;
          exchangeHoldings.set(market, {
            balance: totalBalance,
            avgPrice: parseFloat(acc.avg_buy_price || 0)
          });
        }
      }

      // 내부 상태와 비교
      let syncIssues = 0;

      for (const [coin, strategy] of this.strategies.entries()) {
        const exchangeData = exchangeHoldings.get(coin);
        const internalPosition = strategy.currentPosition;

        if (internalPosition && !exchangeData) {
          // 내부에는 포지션 있지만 거래소에 없음 - 이미 팔린 것
          console.log(`  ⚠️  [${coin}] 동기화: 내부 포지션 있지만 거래소에 없음 → 포지션 제거`);
          strategy.closePosition(internalPosition.entryPrice, '거래소 동기화: 보유량 없음');
          syncIssues++;
        } else if (!internalPosition && exchangeData && exchangeData.balance > 0) {
          // 거래소에는 있지만 내부에 없음 - 수동 매수 또는 동기화 누락
          const minValue = exchangeData.balance * exchangeData.avgPrice;
          if (minValue >= 5000) { // 최소 금액 이상인 경우만
            console.log(`  ⚠️  [${coin}] 동기화: 거래소에 보유 중이지만 내부 포지션 없음`);
            console.log(`      보유량: ${exchangeData.balance.toFixed(8)}, 평균가: ${exchangeData.avgPrice.toLocaleString()}원`);
            // 포지션 복구
            strategy.openPosition(exchangeData.avgPrice, exchangeData.balance, 'BUY');
            console.log(`      → 포지션 복구됨`);
            syncIssues++;
          }
        } else if (internalPosition && exchangeData) {
          // 둘 다 있는 경우 수량 비교
          const diff = Math.abs(internalPosition.amount - exchangeData.balance);
          const diffPercent = (diff / exchangeData.balance) * 100;

          if (diffPercent > 1) { // 1% 이상 차이나면 경고
            console.log(`  ⚠️  [${coin}] 수량 불일치: 내부 ${internalPosition.amount.toFixed(8)} vs 거래소 ${exchangeData.balance.toFixed(8)} (${diffPercent.toFixed(2)}% 차이)`);
            // 거래소 기준으로 업데이트
            strategy.currentPosition.amount = exchangeData.balance;
            syncIssues++;
          }
        }
      }

      if (syncIssues === 0) {
        console.log(`  ✅ 동기화 완료 - 불일치 없음`);
      } else {
        console.log(`  ⚠️  동기화 완료 - ${syncIssues}건 수정됨`);
      }

      // 미체결 주문 확인 및 정리
      await this.cleanupPendingOrders();

    } catch (error) {
      console.error(`  ❌ 동기화 실패: ${error.message}`);
    }
  }

  /**
   * 미체결 주문 정리
   */
  async cleanupPendingOrders() {
    try {
      // 대기 중인 주문 조회
      for (const coin of this.targetCoins) {
        const pendingOrders = await this.upbit.getOrders(coin, 'wait');

        if (pendingOrders && pendingOrders.length > 0) {
          console.log(`  📋 [${coin}] 미체결 주문 ${pendingOrders.length}건 발견`);

          for (const order of pendingOrders) {
            const orderAge = Date.now() - new Date(order.created_at).getTime();
            const orderAgeMinutes = Math.floor(orderAge / 60000);

            // 5분 이상 된 주문은 취소
            if (orderAgeMinutes >= 5) {
              console.log(`    🔄 ${orderAgeMinutes}분 경과 주문 취소: ${order.uuid}`);
              try {
                await this.upbit.cancelOrder(order.uuid);
                console.log(`    ✅ 취소됨`);
              } catch (e) {
                console.log(`    ⚠️  취소 실패: ${e.message}`);
              }
            } else {
              console.log(`    ⏳ ${order.uuid} - ${orderAgeMinutes}분 경과 (5분 후 자동 취소)`);
            }
          }
        }
      }
    } catch (error) {
      // 개별 코인 오류는 무시하고 계속
    }
  }

  /**
   * 다중 코인 매매 사이클
   */
  async executeTradingCycle() {
    const now = new Date();
    console.log(`\n⏰ [${now.toLocaleString('ko-KR')}] 다중 코인 매매 분석 시작`);
    console.log('='.repeat(80));

    // 0. 실전 모드: 거래소 동기화 (10분마다)
    if (!this.dryRun) {
      const lastSync = this._lastSyncTime || 0;
      if (Date.now() - lastSync > 10 * 60 * 1000) { // 10분
        await this.syncWithExchange();
        this._lastSyncTime = Date.now();
      }
    }

    // 1. 계좌 조회
    const accounts = await this.getAccountInfo();
    const krwBalance = this.getKRWBalance(accounts);

    console.log(`\n💰 계좌 정보:`);
    console.log(`  KRW: ${Number(krwBalance).toLocaleString()} 원`);

    // 2. 뉴스 업데이트 (스캘핑 모드에서는 비활성화)
    if (this.useNews) {
      await this.updateNews();
    }

    // 뉴스 데이터 없어도 기술적 분석으로 거래 진행
    let newsSentiment = null;
    if (this.useNews && this.newsData) {
      newsSentiment = this.newsMonitor.analyzeMarketSentiment(this.newsData);
    } else {
      console.log('⚠️  뉴스 데이터 없음 - 기술적 분석만으로 진행');
      // 중립 뉴스 감성으로 대체
      newsSentiment = { overall: 'neutral', score: 0.5, confidence: 0.5 };
    }

    // 3. 각 코인 분석 및 점수 계산
    const coinAnalyses = [];

    this.cycleRequestStats = {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const tickerMap = await this.getTickerMapForCycle();
    for (const coin of this.targetCoins) {
      try {
        const prefetchedTicker = tickerMap?.get(coin);
        const analysis = await this.analyzeCoin(
          coin,
          newsSentiment,
          prefetchedTicker ? { ticker: prefetchedTicker } : {}
        );
        coinAnalyses.push(analysis);
      } catch (error) {
        console.error(`\n❌ ${coin} 분석 오류:`, error.message);
      }
    }

    const marketRegime = summarizeLiveMarketRegime(coinAnalyses, this.config);
    for (const analysis of coinAnalyses) {
      analysis.marketRegime = {
        ...marketRegime,
        coinReturnPercent: analysis.marketReturnPercent
      };
      analysis.decision.details = {
        ...(analysis.decision.details || {}),
        marketRegime: analysis.marketRegime
      };
    }

    this.recordPaperSignalTelemetry(coinAnalyses, marketRegime);

    // 4. 점수 기준으로 정렬 (매수 우선순위)
    coinAnalyses.sort((a, b) => b.decision.scores.total - a.decision.scores.total);

    // AI monitoring은 동일한 분석 snapshot을 관찰할 뿐, 아래의 기존
    // executeOrder() 흐름과 decision 객체를 변경하지 않는다. 특히
    // 설정값 기반 BUY/SELL 자동 실행은 이 callback과 완전히 분리된다.
    this.notifyAnalysisCycle({
      type: 'monitoring-cycle',
      source: 'trading_cycle',
      timestamp: now.toISOString(),
      mode: this.dryRun ? 'DRY_RUN' : 'LIVE',
      krwBalance,
      currentPositions: this.getCurrentPositionCount(),
      analyses: coinAnalyses
    });

    // 5. 상위 코인부터 매매 실행
    console.log('\n📊 코인별 분석 결과 (점수 순):');
    coinAnalyses.forEach((analysis, index) => {
      const strength = analysis.decision.signalStrength;
      const strengthEmoji = {
        'VERY_STRONG': '🔥🔥',
        'STRONG': '🔥',
        'MEDIUM': '💡',
        'WEAK': '💤',
        'NONE': '⏸️'
      }[strength?.level] || '⏸️';

      console.log(`\n${index + 1}. ${analysis.coin}`);
      console.log(`  현재가: ${analysis.currentPrice.toLocaleString()} 원`);
      console.log(`  점수: ${analysis.decision.scores.total}`);
      console.log(`  추천: ${analysis.decision.action} ${strengthEmoji} ${strength?.level || 'NONE'}`);
      console.log(`  이유: ${analysis.decision.reason}`);
    });

    // 6. 현재 포지션 수 확인
    const currentPositions = this.getCurrentPositionCount();
    console.log(`\n📍 현재 포지션 수: ${currentPositions}개 / 최대 ${this.maxPositions}개`);

    // 7. 매매 실행 (강한 신호 우선)
    for (const analysis of coinAnalyses) {
      // 현재 KRW 잔액 갱신 (리밸런싱으로 변동 가능)
      const accounts = await this.getAccountInfo();
      const updatedKrwBalance = this.getKRWBalance(accounts);
      const updatedPositions = this.getCurrentPositionCount();

      await this.executeOrder(
        analysis.coin,
        analysis.decision,
        analysis.currentPrice,
        updatedKrwBalance,
        analysis.coinBalance,
        updatedPositions,
        coinAnalyses  // 리밸런싱용 전체 분석 결과 전달
      );
    }

    // 8. 포트폴리오 요약
    this.printPortfolioSummary();
  }

  /**
   * 개별 코인 분석
   */
  async getTickerMapForCycle() {
    if (!Array.isArray(this.targetCoins) || this.targetCoins.length === 0) return null;
    this.cycleRequestStats = this.cycleRequestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    this.cycleRequestStats.batchTickerRequests += 1;
    try {
      const tickers = await this.upbit.getTicker(this.targetCoins);
      if (!Array.isArray(tickers)) return null;
      return new Map(
        tickers
          .filter(ticker => ticker?.market && Number.isFinite(Number(ticker.trade_price)))
          .map(ticker => [ticker.market, ticker])
      );
    } catch (error) {
      // A batch failure falls back to per-market analysis so one transient
      // response cannot erase the cycle's telemetry.
      console.error(`\n⚠️  전체 ticker batch 조회 실패: ${error.message}`);
      this.cycleRequestStats.batchTickerFailures += 1;
      return null;
    }
  }

  async analyzeCoin(coin, newsSentiment, marketData = {}) {
    const accounts = await this.getAccountInfo();
    const coinBalance = this.getCoinBalance(accounts, coin);

    // 현재가 조회 - null/빈배열 체크
    this.cycleRequestStats = this.cycleRequestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    if (!marketData.ticker) this.cycleRequestStats.individualTickerRequests += 1;
    const ticker = marketData.ticker ? [marketData.ticker] : await this.upbit.getTicker(coin);
    if (!ticker || !Array.isArray(ticker) || ticker.length === 0) {
      throw new Error(`${coin} 현재가 조회 실패 - 응답 없음`);
    }
    if (!ticker[0] || typeof ticker[0].trade_price !== 'number') {
      throw new Error(`${coin} 현재가 조회 실패 - 유효하지 않은 데이터`);
    }
    const currentPrice = ticker[0].trade_price;

    // 캔들 데이터 조회
    if (marketData.candles === undefined) this.cycleRequestStats.candleRequests += 1;
    const candles = marketData.candles || await this.upbit.getMinuteCandles(coin, this.candleUnit, this.candleCount);
    const minimumCandleCount = Math.max(50, (this.config.rsiPeriod || 14) + 10);
    if (!candles || !Array.isArray(candles) || candles.length < minimumCandleCount) {
      this.recordInsufficientCandleData(coin, Array.isArray(candles) ? candles.length : 0, minimumCandleCount);
      throw new Error(`${coin} 캔들 데이터 부족 (${candles?.length || 0}개)`);
    }

    // 기술적 분석
    const technicalAnalysis = this.buildTechnicalAnalysis(candles);

    if (!technicalAnalysis) {
      throw new Error(`${coin} 기술적 분석 실패`);
    }

    const candleFreshness = inspectLatestCandleFreshness(candles, {
      candleUnit: this.candleUnit,
      maxAgeSeconds: this.maxCandleAgeSeconds
    });
    this.recordPaperCandleFreshnessObservation(coin, candleFreshness);

    // 코인별 감성 분석 (스캘핑 모드에서는 호출하지 않음)
    let combinedSentiment = { ...newsSentiment };
    try {
      if (!this.useNews) {
        combinedSentiment = { overall: 'neutral', score: 0, confidence: 0 };
      } else {
        const coinSentiment = await this.newsMonitor.getCoinSentiment(coin, 600000);
        if (coinSentiment && coinSentiment.newsCount > 0) {
          // 코인별 감성과 시장 감성을 결합 (코인별 60%, 시장 40%)
          const coinScore = parseFloat(coinSentiment.score) || 0;
          const marketScore = parseFloat(newsSentiment.score) || 0;
          const weightedScore = (coinScore * 0.6) + (marketScore * 0.4);

          combinedSentiment = {
            ...newsSentiment,
            score: weightedScore.toFixed(2),
            coinSpecific: coinSentiment,
            hasCoinNews: true,
            // 코인별 뉴스가 강한 신호면 추천 업데이트
            recommendation: coinSentiment.newsCount >= 3 && Math.abs(coinScore) > 1
              ? coinSentiment.recommendation
              : newsSentiment.recommendation
          };
        }
      }
    } catch (error) {
      // 코인별 뉴스 실패시 시장 감성만 사용
    }

    // 전략 가져오기
    const strategy = this.getStrategy(coin);

    // 캔들 시각을 확인할 수 없거나 허용 나이보다 오래된 경우에는
    // 전략 상태(특히 이미 처리한 signal key)를 변경하지 않고 fail-closed
    // HOLD를 반환한다. 지연 후 재검증에서도 같은 계약을 다시 확인한다.
    let decision;
    if (!candleFreshness.valid) {
      this.recordPaperCandleFreshnessBlock(candleFreshness.reason, candleFreshness, 'analysis', coin);
      decision = {
        action: 'HOLD',
        reason: `캔들 데이터 신선도 부족 - ${candleFreshness.reason}`,
        confidence: '0.00',
        signalStrength: { level: 'NONE', multiplier: 0, score: 0 },
        scores: { technical: '0.00', news: '0.00', total: '0.00' },
        details: {
          rebound: technicalAnalysis?.indicators?.rebound || null,
          candleFreshness
        }
      };
    } else {
      decision = strategy.makeDecision(
        technicalAnalysis,
        combinedSentiment,
        currentPrice
      );
    }
    const marketRegimeLookback = Math.max(1, Math.floor(Number(this.config.marketRegimeLookback) || 5));
    const marketReturnPercent = calculateLiveMarketReturn(candles, marketRegimeLookback);
    decision.details = {
      ...(decision.details || {}),
      candleFreshness,
      marketReturnPercent
    };

    return {
      coin,
      currentPrice,
      coinBalance,
      technicalAnalysis,
      decision,
      marketReturnPercent,
      candleFreshness,
      sentiment: combinedSentiment
    };
  }

  /**
   * 반등 후보를 주문 직전에 다시 확인한다.
   * 지연 동안 가격/캔들이 바뀌면 기존 분석 결과를 재사용하지 않는다.
   */
  async confirmScalpingEntry(coin, decision, strategy) {
    const requestedDelay = Number(decision.entryDelayMs);
    const minDelay = Math.max(1000, Number(this.entryDelayMinMs) || 1000);
    const maxDelay = Math.max(minDelay, Number(this.entryDelayMaxMs) || 5000);
    const delayMs = Math.min(maxDelay, Math.max(minDelay, Number.isFinite(requestedDelay)
      ? requestedDelay
      : strategy.getEntryDelayMs()));

    console.log(`\n⏳ [${coin}] 반등 확인 완료 - ${delayMs}ms 후 주문 재검증`);
    await this.sleep(delayMs);

    if (this._stopRequested) {
      console.log(`  ⛔ [${coin}] 중지 요청으로 진입 취소`);
      return null;
    }

    let ticker;
    let candles;
    try {
      [ticker, candles] = await Promise.all([
        this.upbit.getTicker(coin),
        this.upbit.getMinuteCandles(coin, this.candleUnit, this.candleCount)
      ]);
    } catch (error) {
      console.log(`  ⚠️  [${coin}] 지연 후 재검증 조회 실패: ${error.message}`);
      return null;
    }

    const latestPrice = ticker?.[0]?.trade_price;
    if (!Number.isFinite(latestPrice) || !Array.isArray(candles)) {
      console.log(`  ⚠️  [${coin}] 지연 후 가격/캔들 데이터가 유효하지 않아 진입 취소`);
      return null;
    }

    const candleFreshness = inspectLatestCandleFreshness(candles, {
      candleUnit: this.candleUnit,
      maxAgeSeconds: this.maxCandleAgeSeconds
    });
    this.recordPaperCandleFreshnessObservation(coin, candleFreshness);
    if (!candleFreshness.valid) {
      this.recordPaperCandleFreshnessBlock(candleFreshness.reason, candleFreshness, 'entry_confirmation', coin);
      console.log(`  ⛔ [${coin}] 지연 후 캔들 신선도 실패: ${candleFreshness.reason}`);
      return null;
    }

    const technicalAnalysis = this.buildTechnicalAnalysis(candles);
    const validation = strategy.validateEntry(technicalAnalysis, latestPrice, decision);
    if (!validation.valid) {
      console.log(`  ⛔ [${coin}] 지연 후 반등 무효화: ${validation.reason}`);
      return null;
    }

    console.log(`  ✅ [${coin}] 지연 후 반등 유지 - 현재가 ${latestPrice.toLocaleString()}원`);
    return { currentPrice: latestPrice, technicalAnalysis, delayMs, candleFreshness };
  }

  /**
   * 주문 실행
   * @param {string} coin - 코인
   * @param {Object} decision - 매매 결정
   * @param {number} currentPrice - 현재가
   * @param {number} krwBalance - KRW 잔액
   * @param {number} coinBalance - 코인 잔액
   * @param {number} currentPositions - 현재 포지션 수
   * @param {Array} coinAnalyses - 전체 코인 분석 결과 (리밸런싱용)
   */
  async executeOrder(...args) {
    if (this._orderInProgress) return null;
    this._orderInProgress = true;
    try {
      return await this._executeOrder(...args);
    } finally {
      this._orderInProgress = false;
    }
  }

  async _executeOrder(coin, decision, currentPrice, krwBalance, coinBalance, currentPositions, coinAnalyses = []) {
    if (this._stopRequested) return null;
    const strategy = this.getStrategy(coin);

    if (decision.action === 'HOLD') {
      return;
    }

    if (decision.action === 'BUY') {
      const signalStrength = decision.signalStrength || { level: 'WEAK', multiplier: 1 };
      const isStrongSignal = ['STRONG', 'VERY_STRONG'].includes(signalStrength.level);
      let entryDelayMs = null;

      // 이미 포지션이 있는 경우
      if (strategy.currentPosition) {
        if (!this.allowAveraging) {
          console.log(`\n⚠️  [${coin}] 이미 포지션 보유중 (추가 매수 비활성화)`);
          return;
        }
        // 추가 매수는 STRONG 이상 신호에서만 허용
        if (!isStrongSignal) {
          console.log(`\n⚠️  [${coin}] 포지션 보유중 - 추가 매수는 STRONG 이상 신호 필요 (현재: ${signalStrength.level})`);
          return;
        }
        console.log(`\n📈 [${coin}] 포지션 보유중 - 강한 신호로 추가 매수 진행`);
      }

      if (!strategy.currentPosition && currentPositions >= this.maxPositions) {
        console.log(`\n⚠️  [${coin}] 최대 포지션 수(${this.maxPositions}개)에 도달하여 진입하지 않음`);
        return;
      }

      if (!strategy.currentPosition && this.isStrictEntryBlockedByLossCircuit()) {
        const circuit = this.getLossCircuitBreakerStatus('strict');
        const remainingMinutes = Math.ceil((circuit.cooldownRemainingMs || 0) / 60000);
        this.recordPaperCircuitBlock();
        console.log(`\n🛑 [${coin}] 전역 손실 회로차단기 쿨다운 중 - 신규 진입 차단 (${remainingMinutes}분 남음)`);
        return;
      }

      const entrySignalKey = decision.entrySignalKey || decision.details?.rebound?.signalKey;
      if (!strategy.currentPosition && this.isScalpingMode &&
        this.isStrictEntryBlockedBySignalWindow(entrySignalKey)) {
        const signalWindow = this.getStrictSignalWindowStatus();
        this.recordPaperSignalWindowBlock();
        console.log(`\n🧭 [${coin}] 동일 signal window 동시 진입 상한 도달 - 신규 진입 차단 (${signalWindow.lastEntryCount}/${signalWindow.maxEntriesPerSignalWindow})`);
        return;
      }

      if (this.isScalpingMode && this.config.marketRegimeEnabled === true &&
        decision.details?.marketRegime?.confirmed !== true) {
        this.recordPaperMarketRegimeBlock();
        const regime = decision.details?.marketRegime;
        console.log(`\n⛔ [${coin}] 시장 regime gate 미통과 - breadth ${Number(regime?.breadth || 0).toFixed(2)} / 평균 ${Number(regime?.averageReturnPercent || 0).toFixed(2)}%`);
        return;
      }

      // 스캘핑 매수는 신호 발생 시점의 가격을 사용하지 않고,
      // 1~5초 지연 후 ticker/완료 캔들을 다시 확인한 뒤 진행한다.
      if (this.isScalpingMode) {
        const confirmation = await this.confirmScalpingEntry(coin, decision, strategy);
        if (!confirmation) return;

        // 지연 중 수동 주문/다른 경로에서 포지션이 먼저 생겼다면
        // 스캘핑 모드에서는 추가 매수하지 않는다.
        if (strategy.currentPosition && !this.allowAveraging) {
          console.log(`  ⛔ [${coin}] 지연 중 포지션이 생성되어 중복 진입 취소`);
          return;
        }

        currentPrice = confirmation.currentPrice;
        entryDelayMs = confirmation.delayMs;
        const latestAccounts = await this.getAccountInfo();
        krwBalance = this.getKRWBalance(latestAccounts);
        currentPositions = this.getCurrentPositionCount();
        if (!strategy.currentPosition && currentPositions >= this.maxPositions) {
          console.log(`  ⛔ [${coin}] 지연 중 최대 포지션 수(${this.maxPositions}개)에 도달하여 진입 취소`);
          return;
        }
      }

      // 동적 투자금액 계산 (시드머니 + 신호 강도 기반)
      const totalAssets = await this.calculateTotalAssets();
      const dynamicInvestment = await this.calculateDynamicInvestmentAmount(totalAssets, signalStrength);

      // 잔액 부족 시 강한 신호면 추가 리밸런싱
      if (!this.isScalpingMode && krwBalance < dynamicInvestment && isStrongSignal && currentPositions > 0) {
        console.log(`\n💡 [${coin}] 잔액 부족하지만 강한 신호 - 추가 리밸런싱 검토`);

        const weakestPosition = this.findWeakestPosition(coin, coinAnalyses);
        if (weakestPosition) {
          const soldAmount = await this.sellForRebalancing(weakestPosition, coin);
          if (soldAmount > 0) {
            krwBalance = this.dryRun ? this.virtualPortfolio.krwBalance : soldAmount;
          }
        }
      }

      const maxInvestment = krwBalance * this.portfolioAllocation;
      const investmentAmount = Math.min(
        dynamicInvestment,
        maxInvestment,
        krwBalance * 0.95
      );

      const baseInvestment = totalAssets * this.investmentRatio;
      console.log(`  💰 투자금액: ${investmentAmount.toLocaleString()}원`);
      console.log(`     (기본 ${baseInvestment.toLocaleString()}원 × ${signalStrength.multiplier} = ${dynamicInvestment.toLocaleString()}원)`);

      if (investmentAmount < 5000) {
        console.log(`\n⚠️  [${coin}] 매수 불가: 잔액 부족 (${krwBalance.toLocaleString()}원)`);
        return;
      }

      // 수수료 계산 (0.05%)
      const FEE_RATE = 0.0005;
      const fee = investmentAmount * FEE_RATE;
      const actualInvestment = investmentAmount - fee;
      const volume = actualInvestment / currentPrice;

      if (this.dryRun) {
        console.log(`\n🧪 [모의투자] ${coin} 매수 주문`);
        console.log(`  금액: ${investmentAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (0.05%)`);
        console.log(`  실투자: ${actualInvestment.toLocaleString()} 원`);
        console.log(`  수량: ${volume.toFixed(8)}`);
        console.log(`  가격: ${currentPrice.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 - 마이너스 방지 체크
        const currentBalance = this.virtualPortfolio.krwBalance || 0;
        if (currentBalance < investmentAmount) {
          console.log(`\n⚠️  [${coin}] 매수 취소: 실시간 잔액 부족 (${currentBalance.toLocaleString()}원 < ${investmentAmount.toLocaleString()}원)`);
          return;
        }
        this.virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
        const existing = this.virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
        const newAmount = existing.amount + volume;
        const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * currentPrice)) / newAmount;
        this.virtualPortfolio.holdings.set(coin, {
          amount: newAmount,
          avgPrice: newAvgPrice,
          entryTime: existing.entryTime || new Date().toISOString() // 최초 매수 시간 유지
        });

        strategy.openPosition(currentPrice, volume, 'BUY');
        this.decorateEntryPosition(strategy, decision, {
          executionPrice: currentPrice,
          delayMs: entryDelayMs
        });
        this.recordStrictSignalWindowEntry(decision.entrySignalKey || decision.details?.rebound?.signalKey);
        this.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매수 알림
        this.notifyTrade({
          type: 'BUY',
          coin,
          price: currentPrice,
          amount: investmentAmount,
          volume,
          reason: decision.reason,
          signalStrength: signalStrength.level,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💵 [${coin}] 실제 매수 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  투자 금액: ${investmentAmount.toLocaleString()} 원`);

        const orderResult = await this.upbit.order(coin, 'bid', investmentAmount, null, 'price');

        if (orderResult.success) {
          const orderId = orderResult.data.uuid;
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.upbit.waitForOrderFill(orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const actualVolume = parseFloat(filledOrder.executed_volume || 0);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = parseFloat(filledOrder.avg_price || 0) || currentPrice;
            const actualAmount = actualVolume * actualPrice;
            const paidFee = parseFloat(filledOrder.paid_fee || 0);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);

            if (fillResult.partial) {
              console.log(`  ⚠️  부분 체결됨 - 잔여: ${filledOrder.remaining_volume}`);
            }

            // 실제 체결 데이터로 포지션 오픈
            strategy.openPosition(actualPrice, actualVolume, 'BUY');
            this.decorateEntryPosition(strategy, decision, {
              executionPrice: actualPrice,
              delayMs: entryDelayMs
            });
            this.recordStrictSignalWindowEntry(decision.entrySignalKey || decision.details?.rebound?.signalKey);

            // 매수 알림 (실제 체결 데이터)
            this.notifyTrade({
              type: 'BUY',
              coin,
              price: actualPrice,
              amount: actualVolume * actualPrice,
              volume: actualVolume,
              reason: decision.reason,
              signalStrength: signalStrength.level,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            // 미체결 - 주문 취소 시도
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  🔄 주문 취소 시도...`);

            try {
              await this.upbit.cancelOrder(orderId);
              console.log(`  ✅ 주문 취소됨`);
            } catch (cancelError) {
              console.error(`  ❌ 주문 취소 실패: ${cancelError.message}`);
              console.log(`  ⚠️  수동 확인 필요 - 주문 ID: ${orderId}`);
            }
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 열지 않음 - 상태 일관성 유지
        }
      }
    }

    if (decision.action === 'SELL') {
      if (!strategy.currentPosition && coinBalance === 0) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 보유 수량 없음`);
        return;
      }

      const sellVolume = strategy.currentPosition
        ? strategy.currentPosition.amount
        : coinBalance;

      // 최소 매도 금액 체크 (5000원)
      const estimatedSellAmount = sellVolume * currentPrice;
      if (estimatedSellAmount < 5000) {
        console.log(`\n⚠️  [${coin}] 매도 불가: 최소 매도금액(5,000원) 미만 (${estimatedSellAmount.toLocaleString()}원)`);
        return;
      }

      if (this.dryRun) {
        // 수수료 계산 (0.05%)
        const FEE_RATE = 0.0005;
        const fee = estimatedSellAmount * FEE_RATE;
        const actualReceived = estimatedSellAmount - fee;

        console.log(`\n🧪 [모의투자] ${coin} 매도 주문`);
        console.log(`  수량: ${sellVolume.toFixed(8)}`);
        console.log(`  예상 금액: ${estimatedSellAmount.toLocaleString()} 원`);
        console.log(`  수수료: ${fee.toLocaleString()} 원 (0.05%)`);
        console.log(`  실수령: ${actualReceived.toLocaleString()} 원`);

        // 가상 포트폴리오 업데이트 (수수료 차감)
        this.virtualPortfolio.krwBalance += actualReceived;

        const holding = this.virtualPortfolio.holdings.get(coin);
        if (holding) {
          holding.amount -= sellVolume;
          if (holding.amount <= 0.00000001) {
            this.virtualPortfolio.holdings.delete(coin);
          } else {
            this.virtualPortfolio.holdings.set(coin, holding);
          }
        }

        // 수익률 계산
        const entryPrice = strategy.currentPosition?.entryPrice || holding?.avgPrice || currentPrice;
        const profitPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(2);

        const closedTrade = strategy.closePosition(currentPrice, decision.reason);
        this.recordPaperStrictTrade(coin, closedTrade, 'CLOSE');
        this.saveVirtualPortfolio();
        console.log(`  잔여 KRW: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);

        // 매도 알림
        this.notifyTrade({
          type: 'SELL',
          coin,
          price: currentPrice,
          amount: estimatedSellAmount,
          volume: sellVolume,
          reason: decision.reason,
          profitPercent,
          mode: 'DRY_RUN'
        });
      } else {
        console.log(`\n💰 [${coin}] 실제 매도 주문 실행`);
        console.log(`  예상 가격: ${currentPrice.toLocaleString()} 원`);
        console.log(`  매도 수량: ${sellVolume.toFixed(8)}`);

        const orderResult = await this.upbit.order(coin, 'ask', sellVolume, null, 'market');

        if (orderResult.success) {
          const orderId = orderResult.data.uuid;
          console.log(`  📝 주문 접수: ${orderId}`);

          // 주문 체결 대기 (최대 30초)
          console.log(`  ⏳ 체결 대기 중...`);
          const fillResult = await this.upbit.waitForOrderFill(orderId, 30000, 1000);

          if (fillResult.filled) {
            const filledOrder = fillResult.order;
            const actualVolume = parseFloat(filledOrder.executed_volume || 0);

            // Upbit API는 avg_price 필드로 평균 체결가를 제공
            const actualPrice = parseFloat(filledOrder.avg_price || 0) || currentPrice;
            const actualAmount = actualVolume * actualPrice;
            const paidFee = parseFloat(filledOrder.paid_fee || 0);

            // 슬리피지 계산
            const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

            // 수익률 계산 (실제 체결가 기준)
            const entryPrice = strategy.currentPosition?.entryPrice || currentPrice;
            const grossProfit = (actualPrice - entryPrice) * actualVolume;
            const netProfit = grossProfit - paidFee; // 매도 수수료 차감
            const profitPercent = ((actualPrice - entryPrice) / entryPrice * 100).toFixed(2);

            console.log(`  ✅ 체결 완료!`);
            console.log(`    실제 체결가: ${actualPrice.toLocaleString()} 원`);
            console.log(`    체결 수량: ${actualVolume.toFixed(8)}`);
            console.log(`    체결 금액: ${actualAmount.toLocaleString()} 원`);
            console.log(`    수수료: ${paidFee.toLocaleString()} 원`);
            console.log(`    슬리피지: ${slippage}%`);
            console.log(`    순수익: ${profitPercent}% (${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()}원)`);

            if (fillResult.partial) {
              const remainingVolume = parseFloat(filledOrder.remaining_volume || 0);
              console.log(`  ⚠️  부분 체결됨 - 미체결 수량: ${remainingVolume.toFixed(8)}`);
              // 부분 체결 시 남은 수량 처리 필요 알림
              console.log(`  ⚠️  미체결 수량은 수동 확인 필요`);
            }

            // 실제 체결 데이터로 포지션 종료
            const closedTrade = strategy.closePosition(actualPrice, decision.reason);
            this.registerRuntimeLoss(closedTrade);

            // 매도 알림 (실제 체결 데이터)
            this.notifyTrade({
              type: 'SELL',
              coin,
              price: actualPrice,
              amount: actualAmount,
              volume: actualVolume,
              reason: decision.reason,
              profitPercent: parseFloat(profitPercent),
              profitAmount: netProfit,
              fee: paidFee,
              mode: 'LIVE',
              orderId,
              slippage: parseFloat(slippage)
            });
          } else {
            // 미체결 - 마켓 주문이므로 이 경우는 드묾
            console.log(`  ⚠️  체결 실패: ${fillResult.error}`);
            console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
            console.log(`  ⚠️  주문 ID: ${orderId}`);
          }
        } else {
          console.error(`  ❌ 주문 실패: ${orderResult.error.message} (${orderResult.error.code})`);
          // 주문 실패 시 포지션 유지 - 수동 확인 필요
          console.log(`  ⚠️  포지션 상태 유지됨 - 수동 확인 필요`);
        }
      }
    }
  }

  /**
   * 현재 포지션 수 조회
   */
  getCurrentPositionCount() {
    let count = 0;
    for (const strategy of this.strategies.values()) {
      if (strategy.currentPosition) {
        count++;
      }
    }
    return count;
  }

  /**
   * 가장 약한 포지션 찾기 (리밸런싱용)
   * @param {string} excludeCoin - 제외할 코인
   * @param {Array} coinAnalyses - 코인별 분석 결과
   * @returns {Object|null} 가장 약한 포지션 정보
   */
  findWeakestPosition(excludeCoin, coinAnalyses) {
    let weakest = null;
    let lowestScore = Infinity;

    // 최소 보유 시간: 10분 (리밸런싱 루프 방지 - 수수료 손실 최소화)
    const MIN_HOLD_TIME_MS = 10 * 60 * 1000;

    // 리밸런싱 쿨다운: 마지막 리밸런싱 후 5분 대기
    const REBALANCE_COOLDOWN_MS = 5 * 60 * 1000;
    if (this.lastRebalanceTime && (Date.now() - this.lastRebalanceTime) < REBALANCE_COOLDOWN_MS) {
      const remainingCooldown = Math.ceil((REBALANCE_COOLDOWN_MS - (Date.now() - this.lastRebalanceTime)) / 1000);
      console.log(`  ⏳ 리밸런싱 쿨다운 중 (${remainingCooldown}초 남음)`);
      return null;
    }

    for (const [coin, strategy] of this.strategies.entries()) {
      if (coin === excludeCoin || !strategy.currentPosition) continue;

      // 최소 보유 시간 체크 - 방금 산 포지션은 리밸런싱 대상에서 제외
      const holdTime = Date.now() - new Date(strategy.currentPosition.entryTime).getTime();
      if (holdTime < MIN_HOLD_TIME_MS) {
        console.log(`  ⏳ [${coin}] 최소 보유 시간 미달 (${Math.floor(holdTime / 1000)}초/${MIN_HOLD_TIME_MS / 1000}초)`);
        continue;
      }

      // 해당 코인의 분석 결과 찾기
      const analysis = coinAnalyses.find(a => a.coin === coin);
      const score = analysis ? parseFloat(analysis.decision.scores.total) : 50;

      // 현재 수익률 계산
      const currentPrice = analysis?.currentPrice || strategy.currentPosition.entryPrice;
      const profitPercent = ((currentPrice - strategy.currentPosition.entryPrice) / strategy.currentPosition.entryPrice) * 100;

      // 점수가 낮고 수익률도 좋지 않은 포지션 우선
      const weaknessScore = score - (profitPercent * 0.5); // 점수 - (수익률 가중치)

      if (weaknessScore < lowestScore) {
        lowestScore = weaknessScore;
        weakest = {
          coin,
          strategy,
          score,
          profitPercent,
          currentPrice,
          position: strategy.currentPosition
        };
      }
    }

    return weakest;
  }

  /**
   * 리밸런싱을 위한 포지션 매도
   * @param {Object} weakestPosition - 매도할 포지션 정보
   * @param {string} targetCoin - 매수할 코인 (로그용)
   */
  async sellForRebalancing(weakestPosition, targetCoin) {
    const { coin, strategy, currentPrice, profitPercent } = weakestPosition;

    // 리밸런싱 수익성 체크: 손실 중인 포지션만 교체 (수수료 0.1% 고려)
    // 수수료로 인한 최소 손실: 매도 0.05% + 매수 0.05% = 0.1%
    const MIN_LOSS_FOR_REBALANCE = -0.5; // 최소 -0.5% 손실 중이어야 리밸런싱
    if (profitPercent > MIN_LOSS_FOR_REBALANCE) {
      console.log(`\n⛔ [리밸런싱 취소] ${coin} 수익률 ${profitPercent.toFixed(2)}%로 양호함`);
      console.log(`  리밸런싱은 ${MIN_LOSS_FOR_REBALANCE}% 이하 손실 포지션만 대상`);
      return 0;
    }

    console.log(`\n🔄 [리밸런싱] ${coin} 매도 → ${targetCoin} 매수 준비`);
    console.log(`  ${coin} 현재 수익률: ${profitPercent.toFixed(2)}%`);

    const sellVolume = strategy.currentPosition.amount;

    if (this.dryRun) {
      // 수수료 계산 (0.05%)
      const FEE_RATE = 0.0005;
      const sellAmount = sellVolume * currentPrice;
      const fee = sellAmount * FEE_RATE;
      const actualReceived = sellAmount - fee;

      console.log(`  🧪 [모의투자] ${coin} 리밸런싱 매도`);
      console.log(`    수량: ${sellVolume.toFixed(8)}`);
      console.log(`    예상 금액: ${sellAmount.toLocaleString()} 원`);
      console.log(`    수수료: ${fee.toLocaleString()} 원 (0.05%)`);
      console.log(`    실수령: ${actualReceived.toLocaleString()} 원`);

      // 가상 포트폴리오 업데이트 (수수료 차감)
      this.virtualPortfolio.krwBalance += actualReceived;

      const holding = this.virtualPortfolio.holdings.get(coin);
      if (holding) {
        holding.amount -= sellVolume;
        if (holding.amount <= 0.00000001) {
          this.virtualPortfolio.holdings.delete(coin);
        }
      }

      strategy.closePosition(currentPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);
      this.saveVirtualPortfolio();

      // 리밸런싱 쿨다운 시간 기록
      this.lastRebalanceTime = Date.now();

      return actualReceived;
    } else {
      console.log(`  💰 [실전] ${coin} 리밸런싱 매도 실행`);
      console.log(`    예상 가격: ${currentPrice.toLocaleString()} 원`);
      console.log(`    매도 수량: ${sellVolume.toFixed(8)}`);

      const orderResult = await this.upbit.order(coin, 'ask', sellVolume, null, 'market');

      if (orderResult.success) {
        const orderId = orderResult.data.uuid;
        console.log(`    📝 주문 접수: ${orderId}`);

        // 주문 체결 대기 (최대 30초)
        console.log(`    ⏳ 체결 대기 중...`);
        const fillResult = await this.upbit.waitForOrderFill(orderId, 30000, 1000);

        if (fillResult.filled) {
          const filledOrder = fillResult.order;
          const actualVolume = parseFloat(filledOrder.executed_volume || 0);

          // Upbit API는 avg_price 필드로 평균 체결가를 제공
          const actualPrice = parseFloat(filledOrder.avg_price || 0) || currentPrice;
          const actualAmount = actualVolume * actualPrice;
          const paidFee = parseFloat(filledOrder.paid_fee || 0);

          const slippage = ((actualPrice - currentPrice) / currentPrice * 100).toFixed(2);

          console.log(`    ✅ 체결 완료!`);
          console.log(`      실제 체결가: ${actualPrice.toLocaleString()} 원`);
          console.log(`      체결 금액: ${actualAmount.toLocaleString()} 원`);
          console.log(`      수수료: ${paidFee.toLocaleString()} 원`);
          console.log(`      슬리피지: ${slippage}%`);

          if (fillResult.partial) {
            console.log(`    ⚠️  부분 체결됨 - 미체결 수량: ${filledOrder.remaining_volume}`);
          }

          strategy.closePosition(actualPrice, `리밸런싱: ${targetCoin} 강한 매수 신호`);

          // 리밸런싱 쿨다운 시간 기록
          this.lastRebalanceTime = Date.now();

          // 잔액 확인
          const accounts = await this.upbit.getAccounts();
          const krwAccount = accounts.find(acc => acc.currency === 'KRW');
          return krwAccount ? parseFloat(krwAccount.balance) : actualAmount;
        } else {
          console.log(`    ⚠️  체결 실패: ${fillResult.error}`);
          console.log(`    ⚠️  리밸런싱 취소 - 포지션 유지`);
          return 0;
        }
      } else {
        console.error(`    ❌ 리밸런싱 매도 실패: ${orderResult.error.message} (${orderResult.error.code})`);
        return 0;
      }
    }
  }

  /**
   * 포트폴리오 요약
   */
  printPortfolioSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 포트폴리오 요약');
    console.log('='.repeat(80));

    for (const coin of this.targetCoins) {
      const strategy = this.getStrategy(coin);
      const stats = strategy.getStatistics();

      console.log(`\n[${coin}]`);

      if (strategy.currentPosition) {
        console.log(`  📍 포지션: 보유중`);
        console.log(`    진입가: ${strategy.currentPosition.entryPrice.toLocaleString()} 원`);
        console.log(`    수량: ${strategy.currentPosition.amount.toFixed(8)}`);
      } else {
        console.log(`  📍 포지션: 없음`);
      }

      if (stats.totalTrades > 0) {
        console.log(`  거래 통계:`);
        console.log(`    총 거래: ${stats.totalTrades}회`);
        console.log(`    승률: ${stats.winRate}`);
        console.log(`    총 손익: ${stats.totalProfit}`);
      }
    }

    console.log('\n' + '='.repeat(80));
  }

  /**
   * 뉴스 업데이트
   */
  async updateNews() {
    const now = Date.now();
    const newsInterval = this.config.newsCheckInterval || 300000;

    if (!this.lastNewsCheck || (now - this.lastNewsCheck) > newsInterval) {
      console.log('\n📡 뉴스 업데이트 중...');
      this.newsData = await this.newsMonitor.collectAndAnalyzeNews();
      this.lastNewsCheck = now;

      const urgentNews = this.newsMonitor.detectUrgentNews(this.newsData);
      if (urgentNews.length > 0) {
        console.log('\n🚨 긴급 뉴스 감지!');
        urgentNews.slice(0, 3).forEach((news, i) => {
          console.log(`  ${i + 1}. ${news.title}`);
        });
      }
    }
  }

  /**
   * 계좌 정보 조회
   */
  async getAccountInfo() {
    if (this.dryRun) {
      // 가상 포트폴리오에서 잔액 반환
      const accounts = [
        { currency: 'KRW', balance: String(this.virtualPortfolio.krwBalance), locked: '0', avg_buy_price: '0' }
      ];

      // 보유 코인 추가
      for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
        const coinSymbol = coin.split('-')[1];
        accounts.push({
          currency: coinSymbol,
          balance: String(holding.amount),
          locked: '0',
          avg_buy_price: String(holding.avgPrice)
        });
      }

      return accounts;
    }
    return await this.upbit.getAccounts();
  }

  /**
   * KRW 잔액 조회 (사용 가능 금액만)
   */
  getKRWBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    if (!krwAccount) return 0;
    // balance는 사용 가능한 금액, locked는 주문 중인 금액 (별도 관리됨)
    return parseFloat(krwAccount.balance) || 0;
  }

  /**
   * KRW 총 잔액 조회 (locked 포함)
   */
  getKRWTotalBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === 'KRW');
    if (!krwAccount) return 0;

    const balance = parseFloat(krwAccount.balance) || 0;
    const locked = parseFloat(krwAccount.locked) || 0;
    return balance + locked;
  }

  /**
   * 코인 잔액 조회
   */
  getCoinBalance(accounts, market) {
    const coinSymbol = market.split('-')[1];
    const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
    return coinAccount ? parseFloat(coinAccount.balance) : 0;
  }

  /**
   * 대기
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MultiCoinTrader;
