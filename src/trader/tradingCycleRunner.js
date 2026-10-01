// TradingCycleRunner — 스캘핑 분석 사이클 파이프라인.
//
// MultiCoinTrader에서 추출. 소유 범위:
// - executeTradingCycle(또는 스냅샷 변형): sync → 분석 → 결정 → 주문 디스패치
// - 배치 티커 맵과 시장 레짐 요약
// - 사이클 요청 통계/스냅샷 컨텍스트/동기화 재시도 상태
//
// 주문 실행·저널·수명주기는 owner를 통해 호출한다.
import { inspectLatestCandleFreshness } from '../risk/candleFreshness.js';
import { inspectTraderMarketQuote } from './positionRiskMonitor.js';

const ANALYSIS_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETRESET'
]);

function analysisNetworkErrorCode(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  return ANALYSIS_NETWORK_ERROR_CODES.has(code) ? code : null;
}

function classifyAnalysisFailure(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (code === 'MARKET_QUOTE_STALE') return 'market_quote_stale';
  if (code === 'MARKET_QUOTE_UNAVAILABLE') return 'market_quote_unavailable';
  if (ANALYSIS_NETWORK_ERROR_CODES.has(code) ||
      /getaddrinfo|dns|timeout|network/.test(message)) {
    return 'network_fetch_failed';
  }
  return 'market_analysis_failed';
}

function createMarketQuoteFreshnessError(market, freshness) {
  const stale = freshness.reason === 'market_source_stale' ||
    freshness.reason === 'market_source_timestamp_in_future';
  const error = new Error(`${market} 거래소 시세를 사용할 수 없습니다: ${freshness.reason}`);
  error.code = stale ? 'MARKET_QUOTE_STALE' : 'MARKET_QUOTE_UNAVAILABLE';
  error.freshness = freshness;
  return error;
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

export class TradingCycleRunner {
  constructor(owner) {
    this.owner = owner;
    this._snapshotContext = undefined;
    this.cycleRequestStats = null;
    this._lastExchangeSyncAttemptTime = 0;
    this.exchangeSyncRetryMs = 5000;
  }

  /**
   * 다중 코인 매매 사이클
   */
  async executeTradingCycle() {
    // 0. 실전 모드: 정기 동기화와 안전 상태 복구를 함께 확인한다.
    if (!this.owner.dryRun) {
      const lastSync = this.owner._lastSyncTime || 0;
      const now = Date.now();
      const globalExchangeStateUnknown = this.owner._liveExchangeStateKnown !== true;
      const scopedOrderStateNeedsRecheck = this.owner._liveEvidenceBlockedMarkets.size > 0 ||
        this.owner._livePendingOrderMarkets.size > 0 || this.owner._liveOrderStateUnknownMarkets.size > 0;
      const exchangeStateNeedsRecheck = globalExchangeStateUnknown || scopedOrderStateNeedsRecheck;
      const syncDue = exchangeStateNeedsRecheck || now - lastSync > 10 * 60 * 1000;
      if (syncDue) {
        const waitingForScopedRetry = scopedOrderStateNeedsRecheck &&
          now - this._lastExchangeSyncAttemptTime < this.exchangeSyncRetryMs;
        const waitingForGlobalRetry = globalExchangeStateUnknown &&
          now - this._lastExchangeSyncAttemptTime < this.exchangeSyncRetryMs;
        if (waitingForGlobalRetry) return false;
        if (!waitingForScopedRetry) {
          this._lastExchangeSyncAttemptTime = now;
          const synchronized = await this.owner.syncWithExchange();
          if (synchronized !== true) {
            if (this.owner.getCurrentPositionCount() > 0) {
              this.owner.pauseForSafetyIncident('exchange_state_unverified');
            }
            console.error('  🛑 거래소 동기화 실패 - 포지션 상태가 확인될 때까지 분석과 신규 매매를 건너뜁니다.');
            return false;
          }
          this.owner._lastSyncTime = Date.now();
          this._lastExchangeSyncAttemptTime = this.owner._lastSyncTime;
        }
      }
    }

    this.owner.beginAnalysisDataCycle();
    const now = new Date();
    console.log(`\n⏰ [${now.toLocaleString('ko-KR')}] 다중 코인 매매 분석 시작`);
    console.log('='.repeat(80));

    // 1. 계좌 조회
    const accounts = await this.owner.getAccountInfo();
    const krwBalance = this.owner.getKRWBalance(accounts);

    console.log(`\n💰 계좌 정보:`);
    console.log(`  KRW: ${Number(krwBalance).toLocaleString()} 원`);

    // 2. 뉴스 업데이트 (스캘핑 모드에서는 비활성화)
    if (this.owner.useNews) {
      await this.owner.updateNews();
    }

    // 뉴스 데이터 없어도 기술적 분석으로 거래 진행
    let newsSentiment;
    if (this.owner.useNews && this.owner.newsData) {
      newsSentiment = this.owner.newsMonitor.analyzeMarketSentiment(this.owner.newsData);
    } else {
      console.log('⚠️  뉴스 데이터 없음 - 기술적 분석만으로 진행');
      // 중립 뉴스 감성으로 대체
      newsSentiment = { overall: 'neutral', score: 0.5, confidence: 0.5 };
    }

    // 3. 각 코인 분석 및 점수 계산
    const coinAnalyses = [];
    const analysisFailureMarkets = [];
    const analysisFailureCounts = {};
    const analysisTransportFailureCodes = {};

    this.cycleRequestStats = {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const tickerMap = await this.owner.getTickerMapForCycle();
    for (const coin of this.owner.targetCoins) {
      try {
        const prefetchedTicker = tickerMap?.get(coin);
        const snapshotMarketData = this._snapshotContext?.marketDataByCoin instanceof Map
          ? this._snapshotContext.marketDataByCoin.get(coin)
          : this._snapshotContext?.marketDataByCoin?.[coin];
        const marketData = snapshotMarketData
          ? {
              ...snapshotMarketData,
              ticker: prefetchedTicker || snapshotMarketData.ticker,
              sharedSnapshot: true
            }
          : prefetchedTicker
            ? { ticker: prefetchedTicker }
            : {};
        const analysis = await this.owner.analyzeCoin(
          coin,
          newsSentiment,
          marketData,
          accounts
        );
        coinAnalyses.push(analysis);
        this.owner.analysisCycleProgress?.add(coin);
      } catch (error) {
        console.error(`\n❌ ${coin} 분석 오류:`, error.message);
        const failureCode = classifyAnalysisFailure(error);
        const transportCode = analysisNetworkErrorCode(error);
        analysisFailureMarkets.push(coin);
        analysisFailureCounts[failureCode] = (analysisFailureCounts[failureCode] || 0) + 1;
        if (transportCode) {
          analysisTransportFailureCodes[transportCode] =
            (analysisTransportFailureCodes[transportCode] || 0) + 1;
        }
      }
    }

    const failureCodes = Object.keys(analysisFailureCounts);
    const analysisFailureCode = failureCodes.length === 1
      ? failureCodes[0]
      : failureCodes.length > 1
        ? 'mixed_analysis_failures'
        : null;
    const analysisDataHealth = this.owner.recordAnalysisDataHealth(coinAnalyses, Date.now(), {
      failureCode: analysisFailureCode,
      failureMarkets: analysisFailureMarkets,
      failureCounts: analysisFailureCounts,
      transportFailureCodes: analysisTransportFailureCodes
    });
    if (!analysisDataHealth.complete) {
      this.owner.recordPaperIncompleteAnalysisTelemetry(analysisDataHealth);
      if (analysisDataHealth.failClosed && this.owner.isRunning) {
        console.error(`\n🛑 분석 데이터 공백 ${analysisDataHealth.gapDurationSeconds.toFixed(1)}초 초과 - paper/live 관찰을 중지합니다.`);
        this.owner.pauseForSafetyIncident('analysis_data_gap');
      }
      return;
    }

    const marketRegime = summarizeLiveMarketRegime(coinAnalyses, this.owner.config);
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

    this.owner.recordPaperSignalTelemetry(coinAnalyses, marketRegime);

    // 4. 점수 기준으로 정렬 (매수 우선순위)
    coinAnalyses.sort((a, b) => b.decision.scores.total - a.decision.scores.total);

    // AI monitoring은 동일한 분석 snapshot을 관찰할 뿐, 아래의 기존
    // executeOrder() 흐름과 decision 객체를 변경하지 않는다. 특히
    // 설정값 기반 BUY/SELL 자동 실행은 이 callback과 완전히 분리된다.
    this.owner.notifyAnalysisCycle({
      type: 'monitoring-cycle',
      source: 'trading_cycle',
      timestamp: now.toISOString(),
      mode: this.owner.dryRun ? 'DRY_RUN' : 'LIVE',
      krwBalance,
      currentPositions: this.owner.getCurrentPositionCount(),
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
    const currentPositions = this.owner.getCurrentPositionCount();
    console.log(`\n📍 현재 포지션 수: ${currentPositions}개 / 최대 ${this.owner.maxPositions}개`);

    // 7. 매매 실행 (강한 신호 우선)
    for (const analysis of coinAnalyses) {
      let updatedKrwBalance = krwBalance;
      let updatedCoinBalance = analysis.coinBalance;
      let updatedPositions = currentPositions;
      if (analysis.decision?.action !== 'HOLD') {
        // Refresh immediately before actionable orders so manual/external
        // account changes still gate BUY/SELL. HOLD returns before reading
        // either balance, position count, or exchange state.
        const latestAccounts = await this.owner.getAccountInfo();
        updatedKrwBalance = this.owner.getKRWBalance(latestAccounts);
        updatedCoinBalance = this.owner.getCoinBalance(latestAccounts, analysis.coin);
        updatedPositions = this.owner.getCurrentPositionCount();
      }

      await this.owner.executeOrder(
        analysis.coin,
        analysis.decision,
        analysis.currentPrice,
        updatedKrwBalance,
        updatedCoinBalance,
        updatedPositions,
        coinAnalyses,  // 리밸런싱용 전체 분석 결과 전달
        this._snapshotContext
      );
    }

    // 8. 포트폴리오 요약
    this.owner.printPortfolioSummary();
  }

  /**
   * Evaluate one paper cycle against a caller-owned shared market snapshot.
   *
   * This is intentionally research-only. The caller supplies one ticker and
   * candle set per market, and the normal dry-run analysis/order/ledger paths
   * are reused for the individual virtual book. Live traders are rejected so
   * this cannot accidentally turn a comparison runner into an order router.
   */
  async executeTradingCycleFromSnapshot(snapshot) {
    if (!this.owner.dryRun) {
      throw new Error('shared snapshot cycle은 DRY_RUN 연구 세션에서만 사용할 수 있습니다.');
    }
    if (!snapshot || !(snapshot.tickerMap instanceof Map) || !(snapshot.priceMap instanceof Map)) {
      throw new Error('shared snapshot cycle에는 tickerMap과 priceMap이 필요합니다.');
    }
    if (!(snapshot.marketDataByCoin instanceof Map) &&
      (!snapshot.marketDataByCoin || typeof snapshot.marketDataByCoin !== 'object')) {
      throw new Error('shared snapshot cycle에는 marketDataByCoin이 필요합니다.');
    }

    if (!this.owner.isRunning || this.owner._stopRequested) {
      throw new Error('shared snapshot cycle의 trader가 실행 상태가 아닙니다.');
    }
    const previousSnapshotContext = this._snapshotContext;
    this._snapshotContext = {
      ...snapshot,
      sharedSnapshot: true,
      skipConfirmationDelay: true
    };

    try {
      // Risk exits are evaluated from the same snapshot before new entries,
      // matching the normal runner's protection-first ordering without a
      // second ticker request per variant.
      await this.owner.monitorOpenPositions(this._snapshotContext);
      await this.owner.executeTradingCycle();
      return await this.owner.recordPaperValidationSnapshot(
        'shared_snapshot_cycle',
        this._snapshotContext.priceMap
      );
    } finally {
      this._snapshotContext = previousSnapshotContext;
    }
  }

  /**
   * 개별 코인 분석
   */
  async getTickerMapForCycle() {
    if (this._snapshotContext?.sharedSnapshot === true &&
      this._snapshotContext.tickerMap instanceof Map) {
      return this._snapshotContext.tickerMap;
    }
    if (!Array.isArray(this.owner.targetCoins) || this.owner.targetCoins.length === 0) return null;
    this.cycleRequestStats = this.cycleRequestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    this.cycleRequestStats.batchTickerRequests += 1;
    try {
      const tickers = await this.owner.marketDataAdapter.getTickers(this.owner.targetCoins);
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

  async analyzeCoin(coin, newsSentiment, marketData = {}, accountSnapshot) {
    const accounts = accountSnapshot === undefined
      ? await this.owner.getAccountInfo()
      : accountSnapshot;
    const coinBalance = this.owner.getCoinBalance(accounts, coin);

    // 현재가 조회 - null/빈배열 체크
    this.cycleRequestStats = this.cycleRequestStats || {
      batchTickerRequests: 0,
      individualTickerRequests: 0,
      candleRequests: 0,
      batchTickerFailures: 0
    };
    const sharedSnapshot = marketData.sharedSnapshot === true;
    if (!marketData.ticker && !sharedSnapshot) this.cycleRequestStats.individualTickerRequests += 1;
    const ticker = marketData.ticker
      ? [marketData.ticker]
      : sharedSnapshot
        ? null
        : await this.owner.marketDataAdapter.getTickers(coin);
    if (!ticker || !Array.isArray(ticker) || ticker.length === 0) {
      throw new Error(`${coin} 현재가 조회 실패 - 응답 없음`);
    }
    if (!ticker[0] || typeof ticker[0].trade_price !== 'number') {
      throw new Error(`${coin} 현재가 조회 실패 - 유효하지 않은 데이터`);
    }
    const marketQuoteFreshness = inspectTraderMarketQuote(
      ticker[0],
      coin,
      this.owner.maxCandleAgeSeconds
    );
    if (!marketQuoteFreshness.fresh) {
      throw createMarketQuoteFreshnessError(coin, marketQuoteFreshness);
    }
    const currentPrice = ticker[0].trade_price;

    // 캔들 데이터 조회
    if (marketData.candles === undefined && !sharedSnapshot) this.cycleRequestStats.candleRequests += 1;
    const candles = marketData.candles || (sharedSnapshot
      ? null
      : await this.owner.marketDataAdapter.getMinuteCandles(coin, this.owner.candleUnit, this.owner.candleCount));
    const minimumCandleCount = Math.max(50, (this.owner.config.rsiPeriod || 14) + 10);
    if (!candles || !Array.isArray(candles) || candles.length < minimumCandleCount) {
      this.owner.recordInsufficientCandleData(coin, Array.isArray(candles) ? candles.length : 0, minimumCandleCount);
      throw new Error(`${coin} 캔들 데이터 부족 (${candles?.length || 0}개)`);
    }

    // 기술적 분석
    const technicalAnalysis = this.owner.buildTechnicalAnalysis(candles);

    if (!technicalAnalysis) {
      throw new Error(`${coin} 기술적 분석 실패`);
    }

    const candleFreshness = inspectLatestCandleFreshness(candles, {
      candleUnit: this.owner.candleUnit,
      maxAgeSeconds: this.owner.maxCandleAgeSeconds
    });
    this.owner.recordPaperCandleFreshnessObservation(coin, candleFreshness);

    // 코인별 감성 분석 (스캘핑 모드에서는 호출하지 않음)
    let combinedSentiment = { ...newsSentiment };
    try {
      if (!this.owner.useNews) {
        combinedSentiment = { overall: 'neutral', score: 0, confidence: 0 };
      } else {
        const coinSentiment = await this.owner.newsMonitor.getCoinSentiment(coin, 600000);
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
    } catch {
      // 코인별 뉴스 실패시 시장 감성만 사용
    }

    // 전략 가져오기
    const strategy = this.owner.getStrategy(coin);

    // 캔들 시각을 확인할 수 없거나 허용 나이보다 오래된 경우에는
    // 전략 상태(특히 이미 처리한 signal key)를 변경하지 않고 fail-closed
    // HOLD를 반환한다. 지연 후 재검증에서도 같은 계약을 다시 확인한다.
    let decision;
    if (!candleFreshness.valid) {
      this.owner.recordPaperCandleFreshnessBlock(candleFreshness.reason, candleFreshness, 'analysis', coin);
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
    const marketRegimeLookback = Math.max(1, Math.floor(Number(this.owner.config.marketRegimeLookback) || 5));
    const marketReturnPercent = calculateLiveMarketReturn(candles, marketRegimeLookback);
    decision.details = {
      ...(decision.details || {}),
      candleFreshness,
      marketQuoteFreshness,
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
      marketQuoteFreshness,
      sentiment: combinedSentiment
    };
  }
}
