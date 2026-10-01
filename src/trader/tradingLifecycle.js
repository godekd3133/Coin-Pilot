// TradingLifecycle — 트레이더 수명주기와 안전 게이트.
//
// MultiCoinTrader에서 추출. 소유 범위:
// - start/stop·그레이스풀 셧다운·보호 전용 드레이닝
// - LIVE 승격 게이트(assertLiveValidationGate/validatePromotionReport)
// - 런타임 마켓 유니버스 관리(applyRuntimeMarketUniverse)
// - 수동 라이브 세션 준비와 자격 증명 교체
// - 안전 상태(isRunning/entriesPaused/manualRiskProtection 등)
//
// 주문·포지션·포트폴리오 상태는 owner(MultiCoinTrader)를 통해 조회한다.
import fs from 'fs';
import { envString } from '../config/envConfig.js';
import path from 'path';
import UpbitAPI from '../api/upbit.js';
import { assessScalpingValidationReportFreshness } from '../research/scalpingValidationFreshness.js';
import { LIVE_GATE_COMPARABLE_KEYS } from '../research/scalpingValidationConfig.js';

export class TradingLifecycle {
  constructor(owner) {
    this.owner = owner;
    this.isRunning = false;
    this._entriesPaused = false;
    this._gracefulShutdownPromise = null;
    this.stopReason = null;
    this._stopRequested = false;
    this._startPromise = null;
    this._orderInProgress = false;
    this.liveManualPrepared = false;
    this._manualRiskProtection = false;
    this._deferredProtectiveExitIntents = [];
    this._startupSafetyHold = null;
  }

  configureUpbitCredentials({ accessKey, secretKey } = {}) {
    const nextAccessKey = typeof accessKey === 'string' ? accessKey.trim() : '';
    const nextSecretKey = typeof secretKey === 'string' ? secretKey.trim() : '';
    if (!nextAccessKey || !nextSecretKey) throw new Error('Upbit Access Key와 Secret Key를 모두 입력하세요.');
    if (this.owner.dryRun) throw new Error('모의투자 서버에는 실계정 키를 등록할 수 없습니다.');
    if (this.isRunning || this._orderInProgress || this.owner._riskCheckInProgress || this._gracefulShutdownPromise) {
      throw new Error('실행 중이거나 주문을 확인 중일 때는 거래소 키를 바꿀 수 없습니다.');
    }
    if (this.owner.liveCredentialsConfigured) {
      throw new Error('이미 LIVE 키가 설정되어 있어 이 경로로 키를 교체할 수 없습니다.');
    }
    const onlyStartupMarketsAreUnverified =
      this.owner._liveAccountStateKnown !== true &&
      this.owner._liveExchangeStateKnown !== true &&
      (this.owner._livePendingOrderMarkets?.size || 0) === 0 &&
      (this.owner._liveEvidenceBlockedMarkets?.size || 0) === 0 &&
      (this.owner._liveUnresolvedOrderIds?.size || 0) === 0 &&
      (this.owner._liveUnresolvedOrderIntents?.size || 0) === 0;
    if (this.owner.getCurrentPositionCount() > 0 ||
        (this.owner.hasUnresolvedLiveOrderState() && !onlyStartupMarketsAreUnverified)) {
      throw new Error('보유 자산이나 확인이 끝나지 않은 주문이 있어 거래소 키를 바꿀 수 없습니다.');
    }

    this.owner.config.accessKey = nextAccessKey;
    this.owner.config.secretKey = nextSecretKey;
    this.owner.upbit.accessKey = nextAccessKey;
    this.owner.upbit.secretKey = nextSecretKey;
    if (this.owner.riskUpbit instanceof UpbitAPI) {
      this.owner.riskUpbit.accessKey = nextAccessKey;
      this.owner.riskUpbit.secretKey = nextSecretKey;
    }
    this.owner._liveAccountStateKnown = false;
    this.owner._liveExchangeStateKnown = false;
    this.owner._liveVerifiedOrderMarkets.clear();
    this.owner._liveOrderStateUnknownMarkets = new Set(this.owner.getLiveManagedMarkets());
    this.owner._livePendingOrderMarkets.clear();
    this.owner._lastSyncTime = 0;
    this.stopReason = 'exchange_state_unverified';
    this._entriesPaused = true;
    this._manualRiskProtection = false;
    this.owner.stopPositionRiskMonitor();
    this.liveManualPrepared = false;
    return { configured: true };
  }

  /**
   * Read-only LIVE account/order reconciliation for a dashboard that starts
   * without the automatic trading loop. Existing exchange orders are left in
   * place and keep their markets locked until they settle or are handled by
   * the user.
   */
  async prepareManualLiveSession() {
    if (this.owner.dryRun) throw new Error('Manual LIVE preparation requires a LIVE server.');
    if (!this.owner.liveManualPrepareOnBoot) throw new Error('Manual LIVE mode is not enabled for this server.');
    if (!this.owner.liveCredentialsConfigured) throw new Error('Upbit credentials have not been registered.');
    if (this.isRunning || this._orderInProgress || this.owner._riskCheckInProgress || this._gracefulShutdownPromise) {
      throw new Error('The LIVE trader is busy and cannot enter manual-only mode.');
    }

    this._stopRequested = false;
    this._entriesPaused = true;
    this.owner._startupReconciliationPending = true;
    this.owner._riskMonitorProtectiveOnly = false;
    this.owner._riskMonitorExitInProgress = false;
    this._manualRiskProtection = false;
    this.stopReason = 'exchange_state_unverified';
    const synchronized = await this.owner.syncWithExchange({ cancelStaleEngineOrders: false });
    if (synchronized !== true || this.owner._liveExchangeStateKnown !== true || this.owner._liveAccountStateKnown !== true) {
      this.owner._startupReconciliationPending = false;
      this._entriesPaused = true;
      this.isRunning = false;
      this.stopReason = 'exchange_state_unverified';
      this.liveManualPrepared = false;
      return { ready: false, reason: 'exchange_state_unverified' };
    }

    this.owner._startupReconciliationPending = false;
    this._entriesPaused = true;
    this.isRunning = false;
    this.stopReason = 'operator_stop';
    this._manualRiskProtection = this.owner.liveManualRiskProtectionEnabled === true &&
      this.owner.positionRiskCheckIntervalMs > 0;
    if (this._manualRiskProtection) {
      this.owner.startPositionRiskMonitor();
      console.log('\n🛡️  수동 LIVE 보호 감시를 시작합니다 - 보유 포지션의 손절·익절·최대보유시간을 감시합니다.');
    } else if (this.owner.liveManualRiskProtectionEnabled) {
      console.warn('\n⚠️  수동 LIVE 보호 감시가 요청됐지만 리스크 감시 간격이 0이라 보호를 시작할 수 없습니다.');
    }
    this.liveManualPrepared = true;
    return {
      ready: true,
      exchangeStateKnown: true,
      pendingOrderMarkets: [...this.owner._livePendingOrderMarkets],
      manualRiskProtection: this._manualRiskProtection
    };
  }

  start() {
    if (this._startPromise) return this._startPromise;
    const startPromise = this.owner.performStart();
    this._startPromise = startPromise;
    startPromise.then(
      () => { if (this._startPromise === startPromise) this._startPromise = null; },
      () => { if (this._startPromise === startPromise) this._startPromise = null; }
    );
    return startPromise;
  }

  async performStart() {
    if (this.owner._riskMonitorProtectiveOnly) {
      throw new Error('보호 전용 상태에서는 자동매매를 다시 시작할 수 없습니다. 열린 LIVE 포지션이 모두 정리된 뒤 새 trader 인스턴스로 시작하세요.');
    }
    this.owner.assertLiveValidationGate();
    this._stopRequested = false;
    this._startupSafetyHold = false;
    this.owner._startupReconciliationPending = !this.owner.dryRun;
    this._entriesPaused = this.owner._startupReconciliationPending;
    this.owner._riskMonitorProtectiveOnly = false;
    this.owner._riskMonitorExitInProgress = false;
    this._manualRiskProtection = false;
    this.stopReason = this.owner._startupReconciliationPending ? 'exchange_state_unverified' : null;
    console.log(`\n🚀 ${this.owner.isScalpingMode ? '과매도 반응 스캘핑' : '다중 코인'} 자동매매 시스템 시작`);
    console.log(`모드: ${this.owner.dryRun ? '모의투자' : '실전투자'}`);

    console.log(`분석 대상: ${this.owner.targetCoins.length}개 코인`);

    console.log(`포지션 제한: ${this.owner.maxPositions}개`);

    // 투자 비율 표시
    console.log(`투자 비율: 총자산의 ${(this.owner.investmentRatio * 100).toFixed(1)}% (최소 ${this.owner.MIN_ORDER_AMOUNT.toLocaleString()}원)`);

    // 실전 모드: 초기 시드머니 자동 기록 (최초 1회)
    if (!this.owner.dryRun && this.owner.initialSeedMoney === 0) {
      await this.owner.saveInitialSeedMoney();
    }

    // 초기 시드머니 표시
    if (this.owner.initialSeedMoney > 0) {
      console.log(`초기 시드머니: ${this.owner.initialSeedMoney.toLocaleString()}원`);
    }

    console.log('─'.repeat(80));

    if (this.owner._startupReconciliationPending) {
      while (!this.owner._liveExchangeStateKnown && !this._stopRequested) {
        while (this._orderInProgress || this.owner._riskCheckInProgress) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const synchronized = await this.owner.syncWithExchange();
        if (synchronized) {
          this.owner._lastSyncTime = Date.now();
          break;
        }
        if (this.owner._liveAccountStateKnown && this.owner.getCurrentPositionCount() > 0) {
          this._startupSafetyHold = true;
          this.owner.pauseForSafetyIncident('exchange_state_unverified');
        }
        if (!this._stopRequested) await this.owner.sleep(this.owner.exchangeSyncRetryMs);
      }

      if (this._stopRequested || this.owner._riskMonitorProtectiveOnly || this._startupSafetyHold) return;
      if (!this.owner._liveExchangeStateKnown) return;
      this.owner._startupReconciliationPending = false;
      this._entriesPaused = false;
      this.stopReason = null;
    }

    this.isRunning = true;
    this.owner.startPositionRiskMonitor();
    this.owner.startAnalysisDataWatchdog();
    if (!this.owner.dryRun && this.owner.getCurrentPositionCount() > 0) {
      await this.owner.monitorOpenPositions();
    }

    // 스캘핑은 뉴스 수집 지연과 장기 감성을 매수 조건에서 제외한다.
    if (this.owner.useNews) {
      await this.owner.updateNews();
    } else {
      this.owner.newsData = null;
      console.log('🧭 스캘핑 모드: 뉴스 분석 없이 가격 반등만 감시합니다.');
    }

    // 주기적 실행
    while (this.isRunning) {
      try {
        await this.owner.executeTradingCycle();
        await this.owner.recordPaperValidationSnapshot('trading_cycle');
        await this.owner.sleep(this.owner.config.checkInterval || 60000);
      } catch (error) {
        console.error('\n❌ 매매 사이클 오류:', error.message);
        await this.owner.sleep(10000);
      }
    }
  }

  /**
   * 스캘핑 실전 주문은 읽기 전용 워크포워드 검증이 전체 마켓에서
   * 통과하기 전까지 시작하지 않는다. DRY_RUN에는 적용하지 않는다.
   */
  assertLiveValidationGate() {
    if (this.owner.dryRun) return;
    if (this.owner.positionRiskCheckIntervalMs <= 0) {
      throw new Error('실전 매매 차단: 포지션 위험 감시를 비활성화할 수 없습니다. SCALP_RISK_CHECK_INTERVAL_MS를 0보다 크게 설정하세요.');
    }
    if (this.owner.maxRiskDataGapSeconds <= 0) {
      throw new Error('실전 매매 차단: 리스크 데이터 공백 감지를 비활성화할 수 없습니다. SCALP_MAX_RISK_DATA_GAP_SECONDS를 0보다 크게 설정하세요.');
    }
    if (!this.owner.isScalpingMode) return;
    if (this.owner.config.requireValidationPassForLive === false) {
      throw Object.assign(
        new Error('실전 스캘핑 차단: 실전 검증 게이트를 비활성화할 수 없습니다. SCALP_REQUIRE_VALIDATION_PASS=true로 설정하고 최신 fixed_config 검증을 통과하세요.'),
        { code: 'live_validation_bypass_not_supported' }
      );
    }

    const reportFile = this.owner.config.scalpingValidationOutputFile ||
      envString('SCALP_VALIDATION_OUTPUT_FILE') ||
      'scalping_validation.json';
    if (!fs.existsSync(reportFile)) {
      throw new Error(`실전 스캘핑 차단: ${path.basename(reportFile)} 검증 리포트가 없습니다. 먼저 npm run validate:scalping을 실행하세요.`);
    }

    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (error) {
      throw new Error(`실전 스캘핑 차단: 검증 리포트를 읽을 수 없습니다 (${error.message})`, { cause: error });
    }

    this.owner.validatePromotionReport(report);
  }

  validatePromotionReport(report, { now = Date.now(), maxAgeSeconds } = {}) {
    if (!report || report.validationMode !== 'fixed_config') {
      throw new Error('실전 스캘핑 차단: 현재 runtime 설정을 고정 검증한 fixed_config 리포트가 필요합니다. tuned 리포트는 live 승격에 사용할 수 없습니다.');
    }
    if (report.strategyMode !== this.owner.strategyMode) {
      throw new Error(`실전 스캘핑 차단: validation report 전략 모드가 다릅니다 (${report.strategyMode || 'unknown'}).`);
    }
    if (!Array.isArray(report.markets) || report.markets.length === 0) {
      throw new Error('실전 스캘핑 차단: 검증 대상 market 목록이 비어 있습니다.');
    }

    const currentSnapshot = this.owner.getPaperValidationConfigSnapshot();
    const comparableKeys = LIVE_GATE_COMPARABLE_KEYS;
    const reportConfig = report.config || {};
    const backwardCompatibleReportDefaults = {
      maxRiskDataGapSeconds: 30,
      maxAnalysisDataGapSeconds: this.owner.isScalpingMode ? 60 : 0
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

    const confidenceSummary = report.statisticalConfidence;
    const confidenceRowsComplete = Array.isArray(report.results) &&
      report.results.length === report.markets.length &&
      report.results.every(result => {
        const gate = result.validation?.gate?.statisticalConfidence;
        return gate?.required === true &&
          gate.training?.passed === true &&
          gate.validation?.passed === true;
      });
    if (confidenceSummary?.required !== true ||
      confidenceSummary?.method !== 'one_sided_t_mean' ||
      confidenceSummary?.passed !== true ||
      !confidenceRowsComplete) {
      throw new Error('실전 스캘핑 차단: 95% 거래수익 신뢰도 게이트가 없거나 통과하지 않았습니다. 최신 fixed validation을 다시 실행하세요.');
    }

    if (report.promoted !== true) {
      const promoted = Array.isArray(report.promotedMarkets) ? report.promotedMarkets.length : 0;
      const total = Array.isArray(report.markets) ? report.markets.length : 0;
      throw new Error(`실전 스캘핑 차단: 전체 워크포워드 게이트 미통과 (${promoted}/${total}). DRY_RUN=true로 계속 검증하세요.`);
    }

    const freshness = assessScalpingValidationReportFreshness(report.generatedAt, {
      now,
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds })
    });
    if (!freshness.fresh) {
      const error = new Error(
        `실전 스캘핑 차단: 검증 리포트가 오래되었거나 작성 시각을 확인할 수 없습니다 (${freshness.reason}). 최신 fixed validation을 다시 실행하세요.`
      );
      error.code = 'report_not_current';
      throw error;
    }
  }

  stop(reason = null) {
    console.log('\n⏹️  다중 코인 자동매매 시스템 중지');
    if (reason) this.stopReason = reason;
    this._stopRequested = true;
    this._entriesPaused = true;
    this.owner._riskMonitorProtectiveOnly = false;
    this._manualRiskProtection = false;
    this.owner._riskMonitorExitInProgress = false;
    this.isRunning = false;
    this.owner.stopPositionRiskMonitor();
    this.owner.stopAnalysisDataWatchdog();
  }

  pauseForSafetyIncident(reason) {
    const hasLivePosition = !this.owner.dryRun && this.owner.getCurrentPositionCount() > 0;
    if (!hasLivePosition || this.owner.positionRiskCheckIntervalMs <= 0) {
      this.owner.stop(reason);
      return false;
    }

    if (this.owner._riskMonitorProtectiveOnly) return true;
    console.error(
      `\n🛡️  ${reason} - 분석과 신규 진입을 멈추고 기존 LIVE 포지션의 위험 감시를 유지합니다.`
    );
    this.stopReason = reason;
    this.isRunning = false;
    this._stopRequested = false;
    this._entriesPaused = true;
    this.owner._riskMonitorProtectiveOnly = true;
    this.owner.stopAnalysisDataWatchdog();
    this.owner.startPositionRiskMonitor();
    return true;
  }

  requestGracefulShutdown(reason = 'operator_shutdown') {
    if (this._gracefulShutdownPromise) return this._gracefulShutdownPromise;
    const shutdownPromise = this.owner.performGracefulShutdown(reason);
    this._gracefulShutdownPromise = shutdownPromise;
    shutdownPromise.then(
      () => { if (this._gracefulShutdownPromise === shutdownPromise) this._gracefulShutdownPromise = null; },
      () => { if (this._gracefulShutdownPromise === shutdownPromise) this._gracefulShutdownPromise = null; }
    );
    return shutdownPromise;
  }

  async performGracefulShutdown(reason = 'operator_shutdown') {
    this._stopRequested = true;
    this._entriesPaused = true;
    this.isRunning = false;
    this.owner.stopAnalysisDataWatchdog();

    // Let an already-submitted order finish and reconcile before deciding
    // whether the process is flat. No new order can enter while we wait.
    while (this._orderInProgress || this.owner._riskCheckInProgress) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    if (!this.owner.dryRun && this.owner.getCurrentPositionCount() > 0 && !this.owner._riskMonitorProtectiveOnly) {
      this.owner.pauseForSafetyIncident(reason);
    }

    if (!this.owner.dryRun) {
      // A local strategy map can be empty or stale after a restart, lost order
      // response, or partial fill. Do not decide that LIVE is flat until both
      // account balances and target-market open orders have been reconciled.
      while (true) {
        const synchronized = await this.owner.syncWithExchange();
        if (synchronized === true && !this.owner.hasUnresolvedLiveOrderState()) {
          this.owner._lastSyncTime = Date.now();
          break;
        }
        console.error(synchronized === true
          ? '🛑 미해결 LIVE 주문 상태가 남아 있어 종료를 보류하고 재조회합니다.'
          : '🛑 LIVE 거래소 상태를 확인할 수 없어 종료를 보류하고 재조회합니다.');
        await this.owner.sleep(this.owner.exchangeSyncRetryMs);
      }
    }

    if (!this.owner.dryRun && this.owner.getCurrentPositionCount() > 0) {
      if (this.owner.positionRiskCheckIntervalMs <= 0) {
        throw new Error('LIVE 포지션이 남아 있지만 리스크 모니터가 비활성화되어 안전하게 종료할 수 없습니다.');
      }
      return this.owner.pauseForSafetyIncident(reason);
    }
    this.owner.stop(reason);
    return false;
  }

  async waitForProtectiveDrain() {
    while (this.owner._riskMonitorProtectiveOnly) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return this.owner.getCurrentPositionCount() === 0;
  }

  finishProtectiveMonitoringWhenFlat() {
    if (!this.owner._riskMonitorProtectiveOnly || this.owner.getCurrentPositionCount() > 0) return false;
    this.owner._riskMonitorProtectiveOnly = false;
    if (this._manualRiskProtection) {
      console.log('\n✅ 감시 중이던 LIVE 포지션이 모두 닫혔습니다. 수동 보호 감시는 유지되며 신규 진입은 재개하지 않습니다.');
      return true;
    }
    this.owner.stopPositionRiskMonitor();
    console.log('\n✅ 감시 중이던 LIVE 포지션이 모두 닫혀 위험 감시가 idle 상태가 됐습니다. 신규 진입은 재개하지 않습니다.');
    return true;
  }

  getRuntimeSafetyStatus() {
    return {
      runtimeState: this.owner._riskMonitorProtectiveOnly
        ? 'PROTECTIVE_ONLY'
        : !this.owner.dryRun && !this.owner._liveExchangeStateKnown ? 'SYNC_REQUIRED'
        : this.isRunning ? 'RUNNING' : 'STOPPED',
      entriesPaused: this._entriesPaused || this._stopRequested || (!this.owner.dryRun && !this.owner._liveExchangeStateKnown),
      manualProtectionActive: this._manualRiskProtection === true && this.owner.positionRiskTimer !== null,
      protectiveMonitorActive: this.owner._riskMonitorProtectiveOnly && this.owner.positionRiskTimer !== null,
      stopReason: this.stopReason || (!this.owner.dryRun && !this.owner._liveExchangeStateKnown ? 'exchange_state_unverified' : null),
      exchangeStateKnown: this.owner.dryRun ? null : this.owner._liveExchangeStateKnown
    };
  }

  /**
   * 대시보드 /api/config/update 경유 런타임 대상 마켓·포지션 상한 갱신.
   * targetCoins: KRW-* 코드 배열 또는 'ALL'(스캘핑에서는 유동성 상위 N개로 해석).
   * LIVE 모드에서는 새 관리 마켓이 다시 미검증 상태로 표시되어 sync gate가
   * 재적용된다.
   */
  async applyRuntimeMarketUniverse({ targetCoins, scalpMaxMarkets, maxPositions } = {}) {
    if (scalpMaxMarkets !== undefined) {
      const value = Number(scalpMaxMarkets);
      if (!Number.isInteger(value) || value < 1 || value > 500) {
        throw new Error('scalpMaxMarkets must be an integer from 1 to 500');
      }
      this.owner.config.maxScalpMarkets = value;
    }
    if (maxPositions !== undefined) {
      const value = Number(maxPositions);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error('maxPositions must be an integer from 1 to 50');
      }
      this.owner.maxPositions = value;
      this.owner.config.maxPositions = value;
    }
    if (targetCoins !== undefined && targetCoins !== null) {
      let resolved;
      if (typeof targetCoins === 'string' && targetCoins.trim().toUpperCase() === 'ALL') {
        resolved = await this.owner.resolveAllKrwMarketUniverse();
      } else if (Array.isArray(targetCoins)) {
        const seen = new Set();
        resolved = [];
        for (const entry of targetCoins) {
          const code = String(entry || '').trim().toUpperCase();
          if (!/^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$/.test(code) || seen.has(code)) continue;
          seen.add(code);
          resolved.push(code);
        }
        if (resolved.length === 0) {
          throw new Error(`targetCoins must contain at least one valid ${this.owner.quoteAsset}-* market`);
        }
      } else {
        throw new Error(`targetCoins must be an array of ${this.owner.quoteAsset}-* codes or "ALL"`);
      }
      this.owner.targetCoins = resolved;
      this.owner.config.targetCoins = [...resolved];
      if (resolved.length <= 20) {
        for (const coin of resolved) this.owner.getStrategy(coin);
      }
      if (!this.owner.dryRun) {
        this.owner._liveOrderStateUnknownMarkets = new Set(this.owner.getLiveManagedMarkets());
      }
    }
    return {
      targetCoins: [...this.owner.targetCoins],
      scalpMaxMarkets: this.owner.config.maxScalpMarkets ?? null,
      maxPositions: this.owner.maxPositions
    };
  }

  async resolveAllKrwMarketUniverse() {
    const markets = await this.owner.marketDataAdapter.getMarkets();
    const krwMarkets = (Array.isArray(markets) ? markets : [])
      .map(entry => entry?.market)
      .filter(market => typeof market === 'string' && market.startsWith(`${this.owner.quoteAsset}-`));
    if (krwMarkets.length === 0) {
      throw new Error(`${this.owner.quoteAsset} 마켓 목록을 불러오지 못했습니다.`);
    }
    if (!this.owner.isScalpingMode) return krwMarkets;
    const tickers = await this.owner.marketDataAdapter.getTickers(krwMarkets);
    const limit = Math.max(1, Math.floor(Number(this.owner.config.maxScalpMarkets)) || 20);
    const ranked = [...(Array.isArray(tickers) ? tickers : [])]
      .filter(ticker => Number.isFinite(Number(ticker?.acc_trade_price_24h)))
      .sort((a, b) => Number(b.acc_trade_price_24h) - Number(a.acc_trade_price_24h))
      .slice(0, limit)
      .map(ticker => ticker.market);
    if (ranked.length === 0) {
      throw new Error('유동성 상위 스캘핑 마켓을 찾지 못했습니다.');
    }
    return ranked;
  }

  getLiveManagedMarkets() {
    return [...new Set([
      ...this.owner.targetCoins,
      ...(this.owner._liveOrderStateUnknownMarkets?.values?.() || []),
      ...(this.owner._livePendingOrderMarkets?.values?.() || []),
      ...(this.owner._manualOrderReconciliationMarkets?.values?.() || []),
      ...[...this.owner.strategies.entries()]
        .filter(([, strategy]) => strategy?.currentPosition)
        .map(([market]) => market),
      ...(this.owner._liveRecoveredManagedMarkets?.values?.() || [])
    ])];
  }
}
