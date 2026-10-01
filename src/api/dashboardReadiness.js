/**
 * 대시보드 readiness 빌더.
 *
 * /health, /ready, /service-ready, /trading-ready가 공유하는 검사 로직.
 * HTTP 표현은 서버에 두고, 트레이더 건강/스케줄러 압력/스냅샷 상태의
 * 계산만 이 모듈이 소유한다. 서비스 readiness와 트레이딩 readiness는
 * 의도적으로 분리된다 — 멈추거나 보호 전용인 트레이더도 안전한 읽기
 * 전용 상태는 제공할 수 있다.
 */
export class DashboardReadiness {
  constructor({
    tradingSystem = null,
    publicMarketDataSource = null,
    isHttpListening = () => false,
    getTradingSystem = null,
    getPublicMarketDataSource = null
  } = {}) {
    this._tradingSystem = getTradingSystem || (() => tradingSystem);
    this._publicSource = getPublicMarketDataSource || (() => publicMarketDataSource);
    this.isHttpListening = isHttpListening;
  }

  build(now = Date.now()) {
    const checks = {
      httpServerListening: this.isHttpListening() === true,
      marketDataScheduler: this.buildMarketDataSchedulerDiagnostics(),
      publicMarketSnapshot: this.buildPublicMarketSnapshotDiagnostics()
    };
    let ready = checks.httpServerListening;

    const trader = this._tradingSystem();
    if (trader && typeof trader.isRunning === 'boolean') {
      checks.traderRunning = trader.isRunning;
      ready = ready && trader.isRunning;
      let runtimeSafety = null;
      if (typeof trader.getRuntimeSafetyStatus === 'function') {
        try {
          runtimeSafety = trader.getRuntimeSafetyStatus() || null;
        } catch {
          runtimeSafety = null;
        }
      }
      checks.runtimeSafetyAvailable = Boolean(runtimeSafety && typeof runtimeSafety === 'object');
      if (checks.runtimeSafetyAvailable) {
        checks.runtimeState = runtimeSafety.runtimeState;
        checks.entriesPaused = runtimeSafety.entriesPaused;
        checks.protectiveMonitorActive = runtimeSafety.protectiveMonitorActive;
        checks.stopReason = runtimeSafety.stopReason;
        checks.exchangeStateKnown = runtimeSafety.exchangeStateKnown;
        if (runtimeSafety.exchangeStateKnown === false ||
          (trader.dryRun !== true && runtimeSafety.exchangeStateKnown !== true)) ready = false;
      } else {
        ready = false;
      }

      const lastCycleAt = trader.paperValidation?.telemetry?.lastCycleAt || null;
      const lastCycleMs = lastCycleAt ? Date.parse(lastCycleAt) : null;
      checks.lastCycleAt = lastCycleAt;
      if (Number.isFinite(lastCycleMs)) {
        checks.lastCycleAgeSeconds = Math.max(0, Math.floor((now - lastCycleMs) / 1000));
      }

      let analysis = null;
      if (typeof trader.getAnalysisDataHealthStatus === 'function') {
        try {
          analysis = trader.getAnalysisDataHealthStatus(now) || null;
        } catch {
          analysis = null;
        }
      }
      checks.analysisHealthAvailable = Boolean(analysis && typeof analysis === 'object');
      checks.analysisHealthy = Boolean(analysis && typeof analysis.failClosed === 'boolean' &&
        analysis.failClosed === false);
      checks.analysisStaleReason = analysis?.staleReason || null;
      {
        const lastCompleteAt = analysis?.lastCompleteAt || null;
        const lastCompleteMs = lastCompleteAt ? Date.parse(lastCompleteAt) : null;
        const intervalValue = trader.config?.checkInterval;
        const intervalConfigured = intervalValue !== undefined && intervalValue !== null && intervalValue !== '';
        const configuredIntervalMs = intervalConfigured ? Number(intervalValue) : 60_000;
        const intervalValid = Number.isFinite(configuredIntervalMs) &&
          configuredIntervalMs > 0 && configuredIntervalMs <= 60 * 60 * 1000;
        const analysisGapValue = analysis?.maxAnalysisDataGapSeconds;
        const analysisGapConfigured = analysisGapValue !== undefined &&
          analysisGapValue !== null && analysisGapValue !== '';
        const analysisGapSeconds = analysisGapConfigured ? Number(analysisGapValue) : NaN;
        const analysisGapValid = Number.isFinite(analysisGapSeconds) &&
          analysisGapSeconds >= 0 && analysisGapSeconds <= 60 * 60;
        const cycleFreshnessLimitMs = Math.min(
          2 * 60 * 60 * 1000,
          Math.max(
            120_000,
            intervalValid ? configuredIntervalMs * 5 : 0,
            analysisGapValid ? analysisGapSeconds * 1000 : 0
          )
        );
        const hasCompleteCycle = Number.isFinite(lastCompleteMs) && lastCompleteMs <= now;
        const cycleAgeMs = hasCompleteCycle ? now - lastCompleteMs : null;
        checks.analysisCycleConfigValid = intervalValid && analysisGapValid;
        checks.analysisLastCompleteAt = lastCompleteAt;
        checks.analysisFirstCycleComplete = hasCompleteCycle;
        checks.analysisCycleAgeSeconds = cycleAgeMs === null ? null : Math.floor(cycleAgeMs / 1000);
        checks.analysisCycleMaxAgeSeconds = Math.ceil(cycleFreshnessLimitMs / 1000);
        checks.analysisCycleFresh = checks.analysisCycleConfigValid &&
          hasCompleteCycle && cycleAgeMs <= cycleFreshnessLimitMs;
        ready = ready && checks.analysisHealthAvailable && checks.analysisHealthy;
        ready = ready && checks.analysisCycleFresh;
      }
      let risk = null;
      if (typeof trader.getRiskMonitorStatus === 'function') {
        try {
          risk = trader.getRiskMonitorStatus(now) || null;
        } catch {
          risk = null;
        }
      }
      checks.riskHealthAvailable = Boolean(risk && typeof risk === 'object');
      checks.riskHealthy = Boolean(risk && typeof risk.failClosed === 'boolean' &&
        risk.failClosed === false);
      checks.riskStaleReason = risk?.staleReason || null;
      ready = ready && checks.riskHealthAvailable && checks.riskHealthy;
    }

    return {
      ready,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date(now).toISOString(),
      checks
    };
  }

  /**
   * HTTP service readiness is intentionally separate from trading readiness:
   * a stopped or protective-only trader can still serve safe read-only status.
   */
  buildService(now = Date.now()) {
    const checks = {
      httpServerListening: this.isHttpListening() === true,
      marketDataScheduler: this.buildMarketDataSchedulerDiagnostics(),
      publicMarketSnapshot: this.buildPublicMarketSnapshotDiagnostics()
    };
    return {
      ready: checks.httpServerListening,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date(now).toISOString(),
      checks
    };
  }

  async withRateCoordinator(readiness) {
    const upbit = this._tradingSystem()?.upbit;
    if (typeof upbit?.getRateCoordinatorStatus !== 'function') return readiness;

    let status;
    try {
      status = await upbit.getRateCoordinatorStatus();
    } catch {
      status = {
        required: upbit.rateCoordinatorRequired === true,
        enabled: upbit.rateCoordinatorRequired === true,
        available: false,
        failureCode: 'UPBIT_RATE_COORDINATOR_UNAVAILABLE'
      };
    }
    const safeInteger = value => {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
    };
    const failureCode = typeof status?.failureCode === 'string' &&
      /^UPBIT_RATE_COORDINATOR_[A-Z0-9_]+$/.test(status.failureCode)
      ? status.failureCode
      : null;
    const coordinator = {
      required: status?.required === true,
      enabled: status?.enabled === true,
      available: status?.available === true ? true : status?.available === false ? false : null,
      failureCode,
      queuedTotal: safeInteger(status?.queuedTotal),
      inFlightTotal: safeInteger(status?.inFlightTotal),
      maxInFlight: safeInteger(status?.maxInFlight),
      nextStartInMs: safeInteger(status?.nextStartInMs)
    };
    const checks = { ...readiness.checks, marketDataCoordinator: coordinator };
    return {
      ...readiness,
      ready: readiness.ready && (!coordinator.required || coordinator.available === true),
      checks
    };
  }

  /**
   * Public readiness diagnostics for the process-local market-data scheduler.
   * Scheduler pressure is observable here but does not make the HTTP service
   * unready by itself; trading readiness continues to use the trader's
   * fail-closed analysis and risk health contracts above.
   */
  buildMarketDataSchedulerDiagnostics() {
    const unavailable = { available: false };
    try {
      const upbit = this._tradingSystem()?.upbit;
      if (typeof upbit?.getQueueStatus !== 'function') return unavailable;
      const status = upbit.getQueueStatus();
      if (!status || typeof status !== 'object' || Array.isArray(status)) return unavailable;

      const nonNegativeInteger = value => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
      };
      const priorityValues = value => ({
        normal: nonNegativeInteger(value?.normal),
        risk: nonNegativeInteger(value?.risk)
      });
      const queuedByPriority = priorityValues(status.queuedByPriority);
      const maxQueuedByPriority = priorityValues(status.maxQueuedByPriority);
      const isQueueSaturated = (queued, maximum) => {
        if (queued === null || maximum === null) return null;
        return maximum === 0 ? queued > 0 : queued >= maximum;
      };
      const normalQueueSaturated = isQueueSaturated(queuedByPriority.normal, maxQueuedByPriority.normal);
      const riskQueueSaturated = isQueueSaturated(queuedByPriority.risk, maxQueuedByPriority.risk);
      const backoffRemainingMs = nonNegativeInteger(status.backoffRemainingMs);

      return {
        available: true,
        queueLength: nonNegativeInteger(status.queueLength),
        queuedByPriority,
        oldestWaitAgeMsByPriority: priorityValues(status.oldestWaitAgeMsByPriority),
        inFlightByPriority: priorityValues(status.inFlightByPriority),
        inFlightTotal: nonNegativeInteger(status.inFlightTotal),
        maxInFlight: nonNegativeInteger(status.maxInFlight),
        maxQueuedByPriority,
        nextStartInMs: nonNegativeInteger(status.nextStartInMs),
        backoffRemainingMs,
        pressure: {
          normalQueueSaturated,
          riskQueueSaturated,
          backoffActive: backoffRemainingMs === null ? null : backoffRemainingMs > 0
        }
      };
    } catch {
      return unavailable;
    }
  }

  buildPublicMarketSnapshotDiagnostics() {
    try {
      const status = this._publicSource()?.getSnapshotStoreStatus?.();
      if (!status || typeof status !== 'object') return { available: false };
      return {
        available: status.available === true,
        marketCount: Number.isSafeInteger(status.marketCount) && status.marketCount >= 0
          ? status.marketCount
          : null,
        persistedAt: typeof status.persistedAt === 'string' ? status.persistedAt : null,
        dirty: status.dirty === true,
        readOnly: status.readOnly === true,
        persistenceHealthy: status.persistenceHealthy === true,
        loadHealthy: status.loadHealthy === true
      };
    } catch {
      return { available: false };
    }
  }

  /**
   * Entry-capable readiness rejects observer-only runtimes even though they
   * may be fully healthy as an HTTP service.
   */
  buildTrading(now = Date.now()) {
    const readiness = this.build(now);
    const trader = this._tradingSystem();
    const traderCanTrade = Boolean(
      trader && typeof trader.isRunning === 'boolean' &&
      trader.isRunning && trader.readOnlyObserver !== true
    );
    const checks = {
      ...readiness.checks,
      traderCanTrade,
      tradingHealthChecksPassed: Boolean(
        traderCanTrade &&
        readiness.checks.runtimeSafetyAvailable === true &&
        readiness.checks.entriesPaused === false &&
        (trader.dryRun === true || readiness.checks.exchangeStateKnown === true) &&
        readiness.checks.analysisHealthAvailable === true &&
        readiness.checks.analysisHealthy === true &&
        readiness.checks.analysisFirstCycleComplete === true &&
        readiness.checks.analysisCycleFresh === true &&
        readiness.checks.riskHealthAvailable === true &&
        readiness.checks.riskHealthy === true
      )
    };
    return {
      ...readiness,
      ready: readiness.ready && checks.tradingHealthChecksPassed,
      checks
    };
  }
}

export default DashboardReadiness;
