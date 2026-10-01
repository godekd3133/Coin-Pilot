// PositionRiskMonitor — 오픈 포지션 리스크 루프와 분석-데이터 헬스 상태.
//
// MultiCoinTrader에서 추출. 소유 범위:
// - 1초 주기 티커 리스크 루프(startPositionRiskMonitor/monitorOpenPositions)
// - 리스크 데이터 갭 fail-closed 신선도(riskMonitorState)
// - 분석 사이클 완전성/신선도(analysisDataHealthState + watchdog)
// - 보호 전용(protective-only) 드레이닝과 수동 리스크 보호 인텐트
//
// 수명주기(stop/pauseForSafetyIncident 등)와 트레이더 상태는 owner를 통해 조회한다.
import {
  getRiskMonitorStatus,
  recordRiskMonitorAttempt,
  recordRiskMonitorFailure,
  recordRiskMonitorIdle,
  recordRiskMonitorStale,
  recordRiskMonitorSuccess,
  recordRiskMonitorWatchdogTick
} from '../risk/riskMonitor.js';
import {
  getAnalysisDataHealthStatus,
  recordAnalysisDataAttempt,
  recordAnalysisDataFailure,
  recordAnalysisDataStale,
  recordAnalysisDataSuccess
} from '../risk/analysisDataHealth.js';
import { inspectMarketQuoteFreshness } from '../api/marketQuoteFreshness.js';

export function inspectTraderMarketQuote(ticker, market, maximumAgeSeconds, now = Date.now()) {
  return inspectMarketQuoteFreshness(ticker, {
    now,
    maximumAgeSeconds,
    expectedMarket: market
  });
}

export class PositionRiskMonitor {
  constructor(owner) {
    this.owner = owner;
    this.riskMonitorState = null;
    this.analysisDataHealthState = null;
    this.positionRiskTimer = null;
    this.analysisWatchdogTimer = null;
    this._riskMonitorProtectiveOnly = false;
    this._riskMonitorExitInProgress = false;
    this._riskCheckInProgress = false;
    this.lastRiskStatePersistedAt = 0;
    this.lastAnalysisStatePersistedAt = 0;
    this.riskStatePersistIntervalMs = 0;
    this.analysisCycleProgress = null;
    this.riskUpbit = null;
    this.maxRiskDataGapSeconds = 0;
    this.maxAnalysisDataGapSeconds = 0;
    this.positionRiskCheckIntervalMs = 0;
  }

  /**
   * 중지
   */
  syncRiskMonitorState() {
    if (!this.owner.paperValidation) return;
    this.owner.paperValidation.riskMonitor = { ...this.riskMonitorState };
    this.owner.paperValidation.telemetry = this.owner.paperValidation.telemetry || {};
    this.owner.paperValidation.telemetry.riskMonitor = { ...this.riskMonitorState };
  }

  persistRiskMonitorStateIfDue(now = Date.now(), force = false) {
    if (!this.owner.dryRun || !this.owner.paperValidation?.active || !this.owner.paperValidation?.sessionId) {
      return false;
    }
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (!force && this.lastRiskStatePersistedAt > 0 &&
      timestamp - this.lastRiskStatePersistedAt < this.riskStatePersistIntervalMs) {
      return false;
    }
    this.syncRiskMonitorState();
    this.owner.savePaperValidation();
    this.lastRiskStatePersistedAt = timestamp;
    return true;
  }

  getRiskMonitorStatus(now = Date.now()) {
    return getRiskMonitorStatus(
      this.riskMonitorState,
      now,
      this.maxRiskDataGapSeconds
    );
  }

  recordRiskMonitorSuccess(now = Date.now()) {
    this.riskMonitorState = recordRiskMonitorSuccess(
      this.riskMonitorState,
      now,
      this.maxRiskDataGapSeconds
    );
    this.syncRiskMonitorState();
    const status = this.getRiskMonitorStatus(now);
    if (this.riskMonitorState.lastFailureCode === 'RISK_CHECK_STALE' &&
      this.riskMonitorState.continuityEligible === false &&
      (this.owner.isRunning || this.owner._manualRiskProtection)) {
      this.persistRiskMonitorStateIfDue(now, true);
      console.error(
        `\n🛑 늦은 risk ticker 성공 callback으로 확인된 시세 공백 ${status.currentOutageDurationSeconds.toFixed(1)}초 초과 - ` +
        'paper/live 관찰을 중지합니다.'
      );
      this.owner.pauseForSafetyIncident('risk_data_gap');
    } else {
      this.persistRiskMonitorStateIfDue(now);
    }
    return status;
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
    if (this.owner.dryRun && this.owner.paperValidation?.active) {
      this.owner.savePaperValidation();
      this.lastRiskStatePersistedAt = Date.now();
    }
    return {
      ...result,
      status: this.getRiskMonitorStatus(now)
    };
  }

  /**
   * A risk ticker request can be in-flight without throwing yet. Check the
   * timestamp age independently of the request's eventual callback so an
   * open position cannot remain unprotected while the event loop waits on
   * network I/O.
   */
  enforceRiskMonitorFreshness(now = Date.now()) {
    const status = this.getRiskMonitorStatus(now);
    // Explicit request failures already flow through handleRiskMonitorFailure.
    // This guard is specifically for the previously invisible in-flight case
    // where no failure callback has created currentOutageStartedAt yet.
    if (!status.failClosed || status.staleReason !== 'risk_check_stale' ||
      (!this.owner.isRunning && !this.owner._manualRiskProtection)) {
      return status;
    }

    const result = recordRiskMonitorStale(
      this.riskMonitorState,
      now,
      this.maxRiskDataGapSeconds
    );
    this.riskMonitorState = result.state;
    this.syncRiskMonitorState();
    this.persistRiskMonitorStateIfDue(now, true);

    console.error(
      `\n🛑 리스크 시세 freshness ${result.outageDurationSeconds.toFixed(1)}초 초과 - ` +
      '실패 callback 없이도 paper/live 관찰을 중지합니다.'
    );
    this.owner.pauseForSafetyIncident('risk_data_gap');
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
    if (result.failClosed && (this.owner.isRunning || this.owner._manualRiskProtection)) {
      console.error(`\n🛑 리스크 시세 공백 ${result.outageDurationSeconds.toFixed(1)}초 초과 - 신규 매매와 paper 관찰을 중지합니다.`);
      this.owner.pauseForSafetyIncident('risk_data_gap');
    }
    return result;
  }

  syncAnalysisDataHealthState() {
    if (!this.owner.paperValidation) return;
    this.owner.paperValidation.analysisDataHealth = { ...this.analysisDataHealthState };
    this.owner.paperValidation.telemetry = this.owner.paperValidation.telemetry || {};
    this.owner.paperValidation.telemetry.analysisDataHealth = { ...this.analysisDataHealthState };
  }

  persistAnalysisDataStateIfDue(now = Date.now(), force = false) {
    if (!this.owner.dryRun || !this.owner.paperValidation?.active || !this.owner.paperValidation?.sessionId) {
      return false;
    }
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (!force && this.lastAnalysisStatePersistedAt > 0 &&
      timestamp - this.lastAnalysisStatePersistedAt < this.riskStatePersistIntervalMs) {
      return false;
    }
    this.syncAnalysisDataHealthState();
    this.owner.savePaperValidation();
    this.lastAnalysisStatePersistedAt = timestamp;
    return true;
  }

  beginAnalysisDataCycle(now = Date.now()) {
    const wasActive = this.analysisDataHealthState.analysisActive === true;
    this.analysisDataHealthState = recordAnalysisDataAttempt(
      this.analysisDataHealthState,
      now
    );
    this.analysisCycleProgress = new Set();
    this.syncAnalysisDataHealthState();
    if (!wasActive) this.persistAnalysisDataStateIfDue(now, true);
    return this.getAnalysisDataHealthStatus(now);
  }

  getAnalysisDataHealthStatus(now = Date.now()) {
    return getAnalysisDataHealthStatus(
      this.analysisDataHealthState,
      now,
      this.maxAnalysisDataGapSeconds
    );
  }

  enforceAnalysisDataFreshness(now = Date.now()) {
    const status = this.getAnalysisDataHealthStatus(now);
    if (!status.failClosed || status.staleReason !== 'analysis_cycle_stale' || !this.owner.isRunning) {
      return status;
    }

    const expectedMarkets = [...new Set((this.owner.targetCoins || [])
      .map(coin => String(coin || '').trim().toUpperCase())
      .filter(Boolean))];
    const analyzedMarkets = this.analysisCycleProgress instanceof Set
      ? [...this.analysisCycleProgress]
      : [];
    const missingMarkets = expectedMarkets.filter(coin => !analyzedMarkets.includes(coin));
    const result = recordAnalysisDataStale(
      this.analysisDataHealthState,
      {
        expectedMarketCount: expectedMarkets.length,
        analyzedMarketCount: analyzedMarkets.length,
        missingMarkets
      },
      now,
      this.maxAnalysisDataGapSeconds
    );
    this.analysisDataHealthState = result.state;
    this.analysisCycleProgress = null;
    this.syncAnalysisDataHealthState();
    this.persistAnalysisDataStateIfDue(now, true);

    console.error(
      `\n🛑 분석 cycle freshness ${result.gapDurationSeconds.toFixed(1)}초 초과 - ` +
      'paper/live 관찰을 중지합니다.'
    );
    this.owner.pauseForSafetyIncident('analysis_data_gap');
    return {
      ...result,
      status: this.getAnalysisDataHealthStatus(now)
    };
  }

  /**
   * A cycle is complete only when every configured market returned a usable
   * analysis object. A batch ticker failure is acceptable when all individual
   * fallbacks recover; a partial market set is not valid forward evidence.
   */
  recordAnalysisDataHealth(coinAnalyses = [], now = Date.now(), failureDetails = {}) {
    const expectedMarkets = [...new Set((this.owner.targetCoins || [])
      .map(coin => String(coin || '').trim().toUpperCase())
      .filter(Boolean))];
    const analyzedMarkets = new Set((Array.isArray(coinAnalyses) ? coinAnalyses : [])
      .map(analysis => String(analysis?.coin || '').trim().toUpperCase())
      .filter(Boolean));
    const missingMarkets = expectedMarkets.filter(coin => !analyzedMarkets.has(coin));
    const details = {
      expectedMarketCount: expectedMarkets.length,
      analyzedMarketCount: analyzedMarkets.size,
      missingMarkets
    };
    if (missingMarkets.length === 0) {
      this.analysisDataHealthState = recordAnalysisDataSuccess(
        this.analysisDataHealthState,
        details,
        now
      );
      this.analysisCycleProgress = null;
      this.syncAnalysisDataHealthState();
      return {
        complete: true,
        ...details,
        status: this.getAnalysisDataHealthStatus(now),
        failClosed: false
      };
    }

    const result = recordAnalysisDataFailure(
      this.analysisDataHealthState,
      { ...details, ...failureDetails },
      now,
      this.maxAnalysisDataGapSeconds
    );
    this.analysisDataHealthState = result.state;
    this.analysisCycleProgress = null;
    this.syncAnalysisDataHealthState();
    return {
      complete: false,
      ...details,
      ...result,
      failureCode: result.failureCode || null,
      failureMarkets: result.failureMarkets || [],
      transportFailureCodes: failureDetails.transportFailureCodes || {},
      status: this.getAnalysisDataHealthStatus(now)
    };
  }

  startAnalysisDataWatchdog() {
    if (this.analysisWatchdogTimer || this.maxAnalysisDataGapSeconds <= 0) return;
    this.analysisWatchdogTimer = setInterval(() => {
      this.enforceAnalysisDataFreshness();
    }, 1000);
  }

  stopAnalysisDataWatchdog() {
    if (!this.analysisWatchdogTimer) return;
    clearInterval(this.analysisWatchdogTimer);
    this.analysisWatchdogTimer = null;
  }

  startPositionRiskMonitor() {
    if (this.positionRiskTimer || this.positionRiskCheckIntervalMs <= 0) return;
    this.positionRiskTimer = setInterval(() => {
      const now = Date.now();
      if (this.riskMonitorState.monitoringActive === true) {
        this.riskMonitorState = recordRiskMonitorWatchdogTick(this.riskMonitorState, now);
        this.syncRiskMonitorState();
        this.persistRiskMonitorStateIfDue(now);
      }
      this.enforceRiskMonitorFreshness(now);
      if (!this.owner.isRunning && !this._riskMonitorProtectiveOnly && !this.owner._manualRiskProtection) return;
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

  async monitorOpenPositions(snapshotContext = null) {
    if ((!this.owner.isRunning && !this._riskMonitorProtectiveOnly && !this.owner._manualRiskProtection) ||
      this._riskCheckInProgress || this.owner._orderInProgress) return;

    const riskFreshness = this.enforceRiskMonitorFreshness();
    if (!this._riskMonitorProtectiveOnly &&
      riskFreshness.failClosed && riskFreshness.staleReason === 'risk_check_stale') return;

    const strictPositions = [...this.owner.strategies.entries()]
      .filter(([, strategy]) => strategy?.currentPosition)
      .map(([coin, strategy]) => ({ coin, strategy }));
    for (const coin of this.owner._deferredProtectiveExitIntents.keys()) {
      if (!this.owner.strategies.get(coin)?.currentPosition) this.owner._deferredProtectiveExitIntents.delete(coin);
    }
    const winnerShadowActive = this.owner.winnerShadowExtendMinutes > 0 ||
      this.owner.winnerShadowMaxReboundPercent > 0 ||
      Object.keys(this.owner.paperValidation?.winnerShadow?.positions || {}).length > 0;
    const shadowStates = this.owner.dryRun && this.owner.paperValidation?.active
      ? ['shadow', 'looseShadow', ...(winnerShadowActive ? ['winnerShadow'] : [])]
        .map(stateKey => ({ stateKey, book: this.owner.paperValidation[stateKey] }))
        .filter(({ book }) => book?.positions && Object.keys(book.positions).length > 0)
      : [];
    const shadowCoins = shadowStates.flatMap(({ book }) => Object.keys(book.positions));
    const monitoredCoins = [...new Set([
      ...strictPositions.map(position => position.coin),
      ...shadowCoins
    ])];
    if (monitoredCoins.length === 0) {
      if (this.riskMonitorState.monitoringActive === true) {
        this.riskMonitorState = recordRiskMonitorIdle(this.riskMonitorState);
        this.syncRiskMonitorState();
        this.persistRiskMonitorStateIfDue(Date.now(), true);
      }
      this.owner.finishProtectiveMonitoringWhenFlat();
      return;
    }

    const wasMonitoringRisk = this.riskMonitorState.monitoringActive === true;
    const shouldPersistRiskAttempt = !wasMonitoringRisk &&
      this.owner.dryRun &&
      this.owner.paperValidation?.active &&
      this.owner.paperValidation?.sessionId &&
      this.owner.paperValidation?.riskMonitor;
    this.riskMonitorState = recordRiskMonitorAttempt(this.riskMonitorState);
    this.syncRiskMonitorState();
    // Persist the transition before awaiting the network request so a
    // read-only observer can see that an open position is being protected.
    if (shouldPersistRiskAttempt) {
      this.persistRiskMonitorStateIfDue(Date.now(), true);
    }

    this._riskCheckInProgress = true;
    try {
      const tickers = snapshotContext?.sharedSnapshot === true &&
        snapshotContext.tickerMap instanceof Map
        ? [...snapshotContext.tickerMap.values()]
        // Keep protective pricing on its priority-lane exchange client, never the analysis fixture.
        : await this.riskUpbit.getTicker(monitoredCoins, { priority: 'risk' });
      const tickersByMarket = new Map(
        (Array.isArray(tickers) ? tickers : [])
          .filter(ticker => ticker?.market)
          .map(ticker => [ticker.market, ticker])
      );
      const priceMap = new Map();
      const quoteIssues = [];
      for (const market of monitoredCoins) {
        const ticker = tickersByMarket.get(market);
        const freshness = inspectTraderMarketQuote(
          ticker,
          market,
          this.owner.maxCandleAgeSeconds
        );
        if (!freshness.fresh) {
          quoteIssues.push({ market, ...freshness });
          continue;
        }
        priceMap.set(market, Number(ticker.trade_price));
      }
      if (quoteIssues.length > 0) {
        const staleQuote = quoteIssues.some(issue => issue.reason === 'market_source_stale' ||
          issue.reason === 'market_source_timestamp_in_future');
        const error = new Error(
          `risk ticker 시세 신선도 실패 (${quoteIssues.map(({ market, reason }) => `${market}:${reason}`).join(', ')})`
        );
        error.code = staleQuote ? 'STALE_RISK_TICKER' : 'INCOMPLETE_RISK_TICKER';
        error.quoteIssues = quoteIssues;
        throw error;
      }
      this.recordRiskMonitorSuccess();
      if (priceMap.size === 0 ||
        (!this.owner.isRunning && !this._riskMonitorProtectiveOnly && !this.owner._manualRiskProtection)) return;

      if (strictPositions.length > 0) {
        let currentPositions = this.owner.getCurrentPositionCount();
        const exitCandidates = [];
        const canExecuteRiskExit = coin => {
          const previousExitState = this._riskMonitorExitInProgress;
          this._riskMonitorExitInProgress = true;
          try {
            return this.owner.canExecuteLiveOrder(coin, { action: 'SELL' });
          } finally {
            this._riskMonitorExitInProgress = previousExitState;
          }
        };
        for (const { coin, strategy } of strictPositions) {
          if ((!this.owner.isRunning && !this._riskMonitorProtectiveOnly && !this.owner._manualRiskProtection) ||
            this.owner._orderInProgress) break;
          const currentPrice = priceMap.get(coin);
          if (!Number.isFinite(currentPrice) || !strategy.currentPosition) continue;

          const deferredIntent = this.owner._deferredProtectiveExitIntents.get(coin);
          const positionCheck = deferredIntent
            ? { shouldClose: true, reason: deferredIntent.reason, type: deferredIntent.type }
            : strategy.checkPosition(currentPrice);
          if (!positionCheck.shouldClose) continue;

          const exitIntent = {
            reason: positionCheck.reason,
            type: positionCheck.type || deferredIntent?.type || null,
            triggeredAt: deferredIntent?.triggeredAt || new Date().toISOString()
          };
          this.owner._deferredProtectiveExitIntents.set(coin, exitIntent);

          if (!this.owner.dryRun && !canExecuteRiskExit(coin)) {
            if (!this._riskMonitorProtectiveOnly) {
              this.owner.pauseForSafetyIncident('exchange_state_unverified');
            }
            continue;
          }

          exitCandidates.push({ coin, strategy, currentPrice, positionCheck, exitIntent });
        }

        if (exitCandidates.length > 0) {
          let accounts;
          try {
            accounts = await this.owner.getAccountInfo();
            const isFiniteNonnegativeField = value =>
              (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
              Number.isFinite(Number(value)) && Number(value) >= 0;
            if (!Array.isArray(accounts) || accounts.some(account =>
              !account || typeof account.currency !== 'string' || !account.currency.trim() ||
              !isFiniteNonnegativeField(account.balance) || !isFiniteNonnegativeField(account.locked)
            )) {
              const error = new Error('리스크 청산용 거래소 계좌 응답이 올바르지 않습니다.');
              error.code = 'INVALID_RISK_ACCOUNT_SNAPSHOT';
              throw error;
            }
          } catch (error) {
            if (!this.owner.dryRun) this.owner.pauseForSafetyIncident('exchange_state_unverified');
            throw error;
          }

          for (const { coin, strategy, currentPrice, positionCheck, exitIntent } of exitCandidates) {
            if ((!this.owner.isRunning && !this._riskMonitorProtectiveOnly && !this.owner._manualRiskProtection) ||
              this.owner._orderInProgress) break;
            if (!strategy.currentPosition) {
              this.owner._deferredProtectiveExitIntents.delete(coin);
              continue;
            }
            if (!this.owner.dryRun && !canExecuteRiskExit(coin)) {
              if (!this._riskMonitorProtectiveOnly) {
                this.owner.pauseForSafetyIncident('exchange_state_unverified');
              }
              continue;
            }

            this._riskMonitorExitInProgress = this._riskMonitorProtectiveOnly || this.owner._manualRiskProtection;
            try {
              await this.owner.executeOrder(
                coin,
                {
                  action: 'SELL',
                  reason: exitIntent.reason,
                  confidence: '1.00',
                  signalStrength: { level: 'STRONG', multiplier: 1, score: 100 },
                  scores: { technical: '0.00', news: '50.00', total: '0.00' },
                  details: { positionCheck, source: 'position_risk_monitor' }
                },
                currentPrice,
                this.owner.getKRWBalance(accounts),
                this.owner.getCoinBalance(accounts, coin),
                currentPositions,
                [],
                snapshotContext
              );
            } finally {
              this._riskMonitorExitInProgress = false;
            }
            if (!strategy.currentPosition) this.owner._deferredProtectiveExitIntents.delete(coin);
            currentPositions = this.owner.getCurrentPositionCount();
          }
        }
      }

      if (shadowStates.length > 0 && this.owner.isRunning) {
        const timestamp = new Date().toISOString();
        let shadowClosed = false;
        for (const { stateKey, book } of shadowStates) {
          for (const coin of Object.keys(book.positions || {})) {
            const currentPrice = priceMap.get(coin);
            if (!Number.isFinite(currentPrice)) continue;
            const closedBefore = book.closedTrades?.length || 0;
            this.owner.updatePaperShadowPosition(
              { coin, currentPrice, decision: { details: { rebound: null } } },
              false,
              timestamp,
              stateKey
            );
            if ((this.owner.paperValidation[stateKey]?.closedTrades?.length || 0) > closedBefore) {
              shadowClosed = true;
            }
          }
        }
        if (shadowClosed) this.owner.savePaperValidation();
      }
      this.owner.finishProtectiveMonitoringWhenFlat();
    } catch (error) {
      const result = this.handleRiskMonitorFailure(error);
      console.error(`\n⚠️  포지션 리스크 조회 실패: ${error.message} (연속 ${result.status.consecutiveFailures}회, outage ${result.status.currentOutageDurationSeconds.toFixed(1)}초)`);
    } finally {
      this._riskCheckInProgress = false;
    }
  }
}
