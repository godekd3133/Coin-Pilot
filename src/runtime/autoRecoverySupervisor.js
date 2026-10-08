// AutoRecoverySupervisor — 안전 중지(fail-closed) 이후 자동매매를 자동 재개한다.
//
// 배경: 네트워크 일시 장애로 risk_data_gap/analysis_data_gap/
// exchange_state_unverified 사유의 보호 중지가 발생하면, 트레이더는 운영자가
// 다시 시작하기 전까지 영구 정지 상태로 남는다. 이 모듈은 "운영자가 켜 둔"
// 자동화만 대상으로, 거래소 데이터 경로가 다시 건강해졌는지 주기적으로 확인한
// 뒤 기존 start() 경로(실전 게이트·시작 재조정 포함)를 그대로 재호출한다.
//
// 계약:
// - fail-closed 경계 자체는 약화하지 않는다. 데이터 공백 중에는 매매하지 않고,
//   복구 후에만 재개한다. paper 세션의 continuityEligible 불량 표시도 그대로 남는다.
// - 운영자의 명시 중지(control/stop·그레이스풀 셧다운)는 intent를 false로 바꿔
//   자동 재개 대상에서 즉시 제외한다.
// - LIVE 보호 전용(_riskMonitorProtectiveOnly) 드레이닝 중에는 건드리지 않고,
//   포지션이 정리된 뒤 재개한다.
// - 재개는 trader.start()를 통해서만 이루어지므로 LIVE의
//   assertLiveValidationGate·거래소 상태 재동기화가 매번 다시 적용된다.
import fs from 'fs';
import path from 'path';
import { writeDurableJson } from './durableJson.js';
import { AutomationTrackingStore } from './automationTrackingStore.js';
import { inspectMarketQuoteFreshness } from '../api/marketQuoteFreshness.js';

// 자동 재개가 허용되는 중지 사유. 운영자 중지(operator_*)나 종료 계열 사유는
// 포함하지 않는다.
export const AUTO_RECOVERABLE_STOP_REASONS = new Set([
  'risk_data_gap',
  'analysis_data_gap',
  'exchange_state_unverified'
]);

export const AUTOMATION_INTENT_SCHEMA_VERSION = 1;

/** 프로필(가상 포트폴리오 파일)과 같은 저장 경계에 intent 파일을 둔다. */
export function deriveAutomationIntentFile(virtualPortfolioFile) {
  if (typeof virtualPortfolioFile !== 'string' || !virtualPortfolioFile.trim()) {
    throw new TypeError('A virtual portfolio path is required for the automation intent file.');
  }
  return `${path.resolve(virtualPortfolioFile)}.automation_intent.json`;
}

export function readAutomationIntent(file) {
  if (typeof file !== 'string' || !file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || typeof parsed.desiredRunning !== 'boolean') return null;
    return {
      desiredRunning: parsed.desiredRunning === true,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      source: typeof parsed.source === 'string' ? parsed.source : null
    };
  } catch {
    return null;
  }
}

export function writeAutomationIntent(file, { desiredRunning, source } = {}) {
  if (typeof file !== 'string' || !file) {
    throw new TypeError('An automation intent file path is required.');
  }
  const record = {
    version: AUTOMATION_INTENT_SCHEMA_VERSION,
    desiredRunning: desiredRunning === true,
    updatedAt: new Date().toISOString(),
    source: typeof source === 'string' && source ? source : 'unknown'
  };
  writeDurableJson(file, record);
  return record;
}

export class AutoRecoverySupervisor {
  constructor(trader, options = {}) {
    if (!trader || typeof trader !== 'object') {
      throw new TypeError('AutoRecoverySupervisor requires a trader instance.');
    }
    this.trader = trader;
    this.enabled = options.enabled !== false;
    this.probeIntervalMs = Math.max(1000, Math.floor(Number(options.probeIntervalMs) || 15000));
    this.minDownMs = Math.max(0, Number(options.minDownMs ?? 30000) || 0);
    this.requiredHealthyProbes = Math.max(1, Math.floor(Number(options.healthyProbes) || 2));
    this.maxStartBackoffMs = Math.max(this.probeIntervalMs, Number(options.maxStartBackoffMs) || 300000);
    this.intentFile = options.intentFile || null;
    this._probeOverride = typeof options.probe === 'function' ? options.probe : null;
    this._onStartFailure = typeof options.onStartFailure === 'function' ? options.onStartFailure : null;
    this._now = options.now || (() => Date.now());
    this._logger = options.logger || console;
    this._setInterval = options.setInterval || setInterval;
    this._clearInterval = options.clearInterval || clearInterval;

    this._timer = null;
    this._tickInFlight = false;
    this._sawRunning = false;
    this._desiredRunningCache = null;
    this._incidentKey = null;
    this._incidentSince = null;
    this._armed = false;
    this._healthyProbes = 0;
    this._startFailures = 0;
    this._nextAttemptAt = 0;
    this._resumeAttempts = 0;
    this._resumeCount = 0;
    this._pendingResume = false;
    this._lastProbeAt = null;
    this._lastProbeError = null;
    this._lastStartAttemptAt = null;
    this._lastStartError = null;
    this._lastResumedAt = null;
    this._intentWriteError = null;
    this.tracking = new AutomationTrackingStore(trader, this.intentFile ? `${this.intentFile}.tracking.json` : null);
    this._lastTrackingAt = 0;
  }

  start() {
    if (!this.enabled || this._timer) return false;
    this._timer = this._setInterval(() => {
      this.tick().catch(error => {
        this._log('error', `⚠️ 자동 복구 감시 오류: ${error.message}`);
      });
    }, this.probeIntervalMs);
    if (typeof this._timer?.unref === 'function') this._timer.unref();
    return true;
  }

  stop() {
    if (!this._timer) return;
    this._clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * 운영자(제어 API)나 부팅 자동 시작이 자동매매 의도를 바꿀 때 intent를 영구
   * 기록한다. 안전 중지는 intent를 바꾸지 않으므로, desired=true인 채 종료된
   * 프로세스는 재시작 후 자동 복구된다.
   */
  resolveBootIntent(defaultRunning) {
    const saved = readAutomationIntent(this.intentFile);
    if (this.intentFile && fs.existsSync(this.intentFile) && !saved) {
      throw new Error('자동매매 선택 기록을 읽을 수 없어 자동 시작을 보류합니다.');
    }
    if (saved) {
      this._desiredRunningCache = saved.desiredRunning;
      this.tracking.record('restart', { desiredRunning: saved.desiredRunning });
      return saved.desiredRunning;
    }
    this.noteDesiredRunning(defaultRunning === true, 'first_boot', { requirePersistence: true });
    return defaultRunning === true;
  }

  noteDesiredRunning(desiredRunning, source = 'operator', { requirePersistence = false } = {}) {
    const previousDesired = this._desiredRunningCache;
    this._desiredRunningCache = desiredRunning === true;
    if (this.intentFile) {
      try {
        writeAutomationIntent(this.intentFile, {
          desiredRunning: this._desiredRunningCache,
          source
        });
        this._intentWriteError = null;
      } catch (error) {
        this._intentWriteError = error.message;
        this._log('error', `⚠️ 자동화 intent 파일 저장 실패: ${error.message}`);
        if (requirePersistence) { this._desiredRunningCache = previousDesired; throw error; }
      }
    }
    if (!this._desiredRunningCache) { this._sawRunning = false; this._clearIncident(); }
    try { this.tracking.record('operator_intent', { desiredRunning: this._desiredRunningCache, source }); }
    catch (error) { this._log('error', `자동매매 추적 저장 실패: ${error.message}`); }
    return this._desiredRunningCache;
  }

  _readDesiredRunning() {
    if (this._desiredRunningCache !== null) return this._desiredRunningCache;
    const intent = readAutomationIntent(this.intentFile);
    return intent?.desiredRunning === true;
  }

  _clearIncident() {
    this._incidentKey = null;
    this._incidentSince = null;
    this._armed = false;
    this._healthyProbes = 0;
    this._startFailures = 0;
    this._nextAttemptAt = 0;
    this._pendingResume = false;
  }

  _log(level, message) {
    const logger = this._logger;
    const fn = level === 'error' ? logger.error : logger.log;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  /**
   * 분석 사이클과 같은 데이터 경로로 모든 대상 마켓의 ticker 신선도와
   * 캔들 수량을 확인한다. 한 마켓이라도 실패하면 unhealthy다.
   */
  async _probeHealth() {
    if (this._probeOverride) return this._probeOverride(this.trader);
    const markets = [...new Set((this.trader.targetCoins || [])
      .map(market => String(market || '').trim().toUpperCase())
      .filter(Boolean))];
    if (markets.length === 0) {
      return { healthy: false, reason: 'no_target_markets' };
    }

    const tickers = await this.trader.riskUpbit.getTicker(markets, { priority: 'risk' });
    const tickersByMarket = new Map(
      (Array.isArray(tickers) ? tickers : [])
        .filter(ticker => ticker?.market)
        .map(ticker => [ticker.market, ticker])
    );
    for (const market of markets) {
      const freshness = inspectMarketQuoteFreshness(tickersByMarket.get(market), {
        maximumAgeSeconds: this.trader.maxCandleAgeSeconds,
        expectedMarket: market
      });
      if (!freshness.fresh) {
        return { healthy: false, reason: `ticker:${market}:${freshness.reason}` };
      }
    }

    const minimumCandleCount = Math.max(50, (Number(this.trader.config?.rsiPeriod) || 14) + 10);
    for (const market of markets) {
      const candles = await this.trader.marketDataAdapter.getMinuteCandles(
        market,
        this.trader.candleUnit,
        minimumCandleCount
      );
      if (!Array.isArray(candles) || candles.length < minimumCandleCount) {
        return {
          healthy: false,
          reason: `candles:${market}:${Array.isArray(candles) ? candles.length : 0}/${minimumCandleCount}`
        };
      }
    }
    return { healthy: true };
  }

  async tick(nowMs = this._now()) {
    const trader = this.trader;
    if (nowMs - this._lastTrackingAt >= 15000) {
      try { this.tracking.record('runtime'); this._lastTrackingAt = nowMs; }
      catch (error) { this._log('error', `자동매매 추적 저장 실패: ${error.message}`); }
    }
    if (!this.enabled || this._tickInFlight) return this.getStatus();

    if (trader.isRunning === true) {
      this._sawRunning = true;
      if (this._pendingResume) {
        this._resumeCount += 1;
        this._lastResumedAt = new Date(nowMs).toISOString();
        this.tracking.record('resumed');
        this._log('log', '\n✅ 자동매매 자동 복구 완료 - 매매 루프가 다시 실행 중입니다.');
      }
      this._clearIncident();
      return this.getStatus();
    }

    // 시작/종료/보호 드레이닝 진행 중에는 개입하지 않는다.
    if (trader._startPromise || trader._gracefulShutdownPromise ||
        trader._orderInProgress || trader._riskCheckInProgress ||
        trader._riskMonitorProtectiveOnly) {
      return this.getStatus();
    }

    const reason = typeof trader.stopReason === 'string' && trader.stopReason
      ? trader.stopReason
      : null;
    const desired = this._readDesiredRunning();
    const recoverable = reason !== null && AUTO_RECOVERABLE_STOP_REASONS.has(reason);
    const armed = desired === true || (this._sawRunning && recoverable);
    if (!armed) {
      this._clearIncident();
      return this.getStatus();
    }

    const incidentKey = `${reason || 'none'}|${desired ? 'desired' : 'incident'}`;
    if (this._incidentKey !== incidentKey) {
      this._incidentKey = incidentKey;
      this._incidentSince = nowMs;
      this._armed = true;
      this._healthyProbes = 0;
      this._startFailures = 0;
      this._nextAttemptAt = nowMs + this.minDownMs;
      this._log('log',
        `\n🔁 자동매매 자동 복구 대기 (${reason || 'restart_resume'}) - ` +
        '데이터 경로가 복구되면 자동으로 다시 시작합니다.');
    }
    if (nowMs < this._nextAttemptAt) return this.getStatus();

    this._tickInFlight = true;
    try {
      this._lastProbeAt = nowMs;
      let probe;
      try {
        probe = await this._probeHealth();
      } catch (error) {
        probe = { healthy: false, reason: `probe_error:${error.message}` };
      }
      if (!probe?.healthy) {
        const probeReason = probe?.reason || 'unhealthy';
        if (this._lastProbeError !== probeReason || this._healthyProbes !== 0) {
          this._log('error', `⚠️ 자동 복구 건강 확인 실패: ${probeReason}`);
        }
        this._healthyProbes = 0;
        this._lastProbeError = probeReason;
        this._nextAttemptAt = this._now() + this.probeIntervalMs;
        return this.getStatus();
      }
      this._healthyProbes += 1;
      this._lastProbeError = null;
      if (this._healthyProbes < this.requiredHealthyProbes) {
        this._nextAttemptAt = this._now() + this.probeIntervalMs;
        return this.getStatus();
      }

      // 시작 직전 재확인: 운영자 중지·셧다운이 probe 대기 중에 들어왔을 수 있다.
      const stillDesired = this._readDesiredRunning();
      const stillRecoverable = AUTO_RECOVERABLE_STOP_REASONS.has(
        typeof trader.stopReason === 'string' ? trader.stopReason : ''
      );
      if (trader.isRunning === true || trader._startPromise ||
          trader._gracefulShutdownPromise || trader._riskMonitorProtectiveOnly ||
          !(stillDesired === true || (this._sawRunning && stillRecoverable))) {
        return this.getStatus();
      }

      this._resumeAttempts += 1;
      this._lastStartAttemptAt = new Date(this._now()).toISOString();
      const recordStartFailure = error => {
        this._startFailures += 1;
        this._lastStartError = error?.message || 'start_failed';
        try { this.tracking.record('resume_failed', { reason: this._lastStartError }); } catch { /* status exposes persistence errors */ }
        this._healthyProbes = 0;
        this._pendingResume = false;
        const backoff = Math.min(
          this.probeIntervalMs * (2 ** Math.min(this._startFailures, 6)),
          this.maxStartBackoffMs
        );
        this._nextAttemptAt = this._now() + Math.max(this.probeIntervalMs, backoff);
        this._log('error', `❌ 자동매매 자동 재시작 실패: ${this._lastStartError} - 재시도를 예약합니다.`);
        try { this._onStartFailure?.(error); } catch { /* hook 오류는 복구 경로를 막지 않는다 */ }
      };
      let startPromise;
      try {
        startPromise = trader.start();
      } catch (error) {
        recordStartFailure(error);
        return this.getStatus();
      }
      Promise.resolve(startPromise).then(
        () => {},
        recordStartFailure
      );
      this._pendingResume = true;
      this._healthyProbes = 0;
      this._nextAttemptAt = this._now() + this.probeIntervalMs;
      this._log('log', '\n🔁 거래소 데이터 경로 복구 확인 - 자동매매 재시작을 요청했습니다.');
      return this.getStatus();
    } finally {
      this._tickInFlight = false;
    }
  }

  getStatus() {
    const trader = this.trader;
    const reason = typeof trader?.stopReason === 'string' && trader.stopReason
      ? trader.stopReason
      : null;
    const desiredRunning = this._readDesiredRunning();
    const armed = this.enabled === true &&
      trader?.isRunning !== true &&
      (desiredRunning === true ||
        (this._sawRunning && AUTO_RECOVERABLE_STOP_REASONS.has(reason)));
    return {
      enabled: this.enabled,
      active: this._timer !== null,
      armed,
      stopReason: reason,
      desiredRunning,
      incidentSince: this._incidentSince === null
        ? null
        : new Date(this._incidentSince).toISOString(),
      healthyProbes: this._healthyProbes,
      requiredHealthyProbes: this.requiredHealthyProbes,
      nextAttemptAt: this._nextAttemptAt > 0 ? new Date(this._nextAttemptAt).toISOString() : null,
      lastProbeAt: this._lastProbeAt === null ? null : new Date(this._lastProbeAt).toISOString(),
      lastProbeError: this._lastProbeError,
      lastStartAttemptAt: this._lastStartAttemptAt,
      lastStartError: this._lastStartError,
      resumeAttempts: this._resumeAttempts,
      resumeCount: this._resumeCount,
      lastResumedAt: this._lastResumedAt,
      intentWriteError: this._intentWriteError,
      tracking: this.tracking.summary(),
      validationRefresh: this.trader.liveValidationRefresher?.getStatus?.() || null
    };
  }
}

export function createAutoRecoverySupervisor(trader, config = {}, options = {}) {
  const intentFile = config.autoRecoveryStateFile ||
    (trader?.virtualPortfolioFile ? deriveAutomationIntentFile(trader.virtualPortfolioFile) : null);
  const supervisor = new AutoRecoverySupervisor(trader, {
    enabled: config.autoRecoveryEnabled !== false,
    probeIntervalMs: config.autoRecoveryProbeIntervalMs,
    minDownMs: config.autoRecoveryMinDownMs,
    healthyProbes: config.autoRecoveryHealthyProbes,
    intentFile,
    ...options
  });
  return supervisor;
}
