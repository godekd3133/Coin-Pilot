// LiveValidationReportRefresher — LIVE 스캘핑의 fixed_config 검증 리포트를
// 주기적으로 재생성한다.
//
// 배경: assertLiveValidationGate는 24시간 이상 지난 scalping_validation.json을
// 거부한다. 자동 복구(supervisor)나 운영자 시작 시점에 리포트만 오래됐어도
// 영구 블록될 수 있으므로, 게이트 자체를 완화하는 대신 "증거를 갱신"한다.
// 리프레시된 리포트가 promoted/confidence 게이트를 통과하지 못하면 live 게이트는
// 계속 닫힌다 — 안전 계약 자체는 변하지 않는다.
//
// 실행 방식: 자식 프로세스로 validateScalping.js를 실행해 부모 트레이더의
// 메모리/CPU와 격리한다. 현재 runtime 설정과 대상 코인을 매번 캡처하고,
// candle cache 입력은 제거해 신선한 네트워크 윈도우로 검증한다.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_GATE_COMPARABLE_KEYS,
  loadPaperValidationConfigSnapshot
} from '../research/scalpingValidationConfig.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const VALIDATION_SCRIPT_PATH = path.resolve(MODULE_DIR, '../scripts/validateScalping.js');
export const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_REFRESH_MIN_GAP_MS = 30 * 60 * 1000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;

const BOOLEAN_SNAPSHOT_KEYS = new Set([
  'requirePreviousHighBreak', 'requireReboundBelowOverbought', 'requireNextCandleBullish', 'marketRegimeEnabled'
]);
const SIGNAL_PROFILES = new Set(['rsi_rebound', 'momentum_breakout', 'bb_reclaim', 'trend_rebound']);
const RUNTIME_BEHAVIOR_ENV = {
  entryDelayMinMs: 'SCALP_ENTRY_DELAY_MIN_MS',
  entryDelayMaxMs: 'SCALP_ENTRY_DELAY_MAX_MS',
  maxCandleAgeSeconds: 'SCALP_MAX_CANDLE_AGE_SECONDS',
  maxRiskDataGapSeconds: 'SCALP_MAX_RISK_DATA_GAP_SECONDS',
  maxAnalysisDataGapSeconds: 'SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS'
};

export class LiveValidationReportRefresher {
  constructor(trader, options = {}) {
    if (!trader || typeof trader !== 'object') {
      throw new TypeError('LiveValidationReportRefresher requires a trader instance.');
    }
    this.trader = trader;
    this.enabled = options.enabled !== false;
    this.intervalMs = Math.max(60000, Number(options.intervalMs) || DEFAULT_REFRESH_INTERVAL_MS);
    this.minGapMs = Math.max(60000, Number(options.minGapMs) || DEFAULT_REFRESH_MIN_GAP_MS);
    this.timeoutMs = Math.max(60000, Number(options.timeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS);
    this.tickIntervalMs = Math.max(5000, Math.min(Number(options.tickIntervalMs) || DEFAULT_TICK_INTERVAL_MS, this.minGapMs));
    this.reportFile = options.reportFile || trader.config?.scalpingValidationOutputFile || 'scalping_validation.json';
    this.scriptPath = options.scriptPath || VALIDATION_SCRIPT_PATH;
    this._spawn = options.spawn || nodeSpawn;
    this._now = options.now || (() => Date.now());
    this._logger = options.logger || console;
    this._setInterval = options.setInterval || setInterval;
    this._clearInterval = options.clearInterval || clearInterval;
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._env = options.env || process.env;
    this._cwd = options.cwd || process.cwd();
    this._execPath = options.execPath || process.execPath;
    this._snapshotTempRoot = options.snapshotTempRoot || os.tmpdir();

    this._timer = null;
    this._running = false;
    this._queued = false;
    this._queuedReason = null;
    this._nextRunAllowedAt = 0;
    this._runCount = 0;
    this._lastRunStartedAt = null;
    this._lastRunFinishedAt = null;
    this._lastRunReason = null;
    this._lastExitCode = null;
    this._lastError = null;
    this._lastReport = null; // {promoted, generatedAt, promotedMarkets, markets}
  }

  /** LIVE 스캘핑 프로세스에서만 게이트 증거 갱신이 의미 있다. */
  _eligible() {
    return this.enabled === true && this.trader.dryRun === false && this.trader.isScalpingMode === true &&
      this.trader.config?.requireValidationPassForLive !== false;
  }

  start() {
    if (!this._eligible() || this._timer) return false;
    this._timer = this._setInterval(() => {
      this.tick().catch(error => {
        this._log('error', `⚠️ validation 리포트 갱신 감시 오류: ${error.message}`);
      });
    }, this.tickIntervalMs);
    if (typeof this._timer?.unref === 'function') this._timer.unref();
    return true;
  }

  stop() {
    if (!this._timer) return;
    this._clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * 자동 복구나 운영자 start 시도가 게이트에 막혔을 때 호출한다. 리프레시는
   * minGap으로 묶이고, 진행 중이면 플래그만 쌓는다.
   */
  requestRefresh(reason = 'on_demand') {
    if (!this._eligible()) return false;
    this._queued = true;
    this._queuedReason = typeof reason === 'string' && reason ? reason : 'on_demand';
    return true;
  }

  _reportPath() {
    return path.isAbsolute(this.reportFile)
      ? this.reportFile
      : path.resolve(this._cwd, this.reportFile);
  }

  _readReportSummary() {
    try {
      const raw = fs.readFileSync(this._reportPath(), 'utf8');
      const report = JSON.parse(raw);
      return {
        generatedAt: typeof report?.generatedAt === 'string' ? report.generatedAt : null,
        promoted: report?.promoted === true,
        markets: Array.isArray(report?.markets) ? report.markets.length : 0,
        promotedMarkets: Array.isArray(report?.promotedMarkets) ? report.promotedMarkets.length : 0
      };
    } catch {
      return null;
    }
  }

  _automationDesired() {
    if (this.trader.isRunning === true) return true;
    return this.trader.autoRecovery?.getStatus?.().desiredRunning === true;
  }

  async tick(nowMs = this._now()) {
    if (!this._eligible()) return this.getStatus();
    // 그레이스풀 셧다운/보호 드레이닝 중에는 검증 자식 프로세스를 만들지 않는다.
    if (this.trader._gracefulShutdownPromise) return this.getStatus();
    if (this._running) return this.getStatus();

    const desired = this._automationDesired();
    const summary = this._readReportSummary();
    const generatedMs = summary?.generatedAt ? Date.parse(summary.generatedAt) : NaN;
    const scheduledDueAt = desired
      ? (Number.isFinite(generatedMs) ? generatedMs + this.intervalMs : 0)
      : null;

    const scheduledDue = scheduledDueAt !== null && nowMs >= scheduledDueAt;
    const queuedDue = this._queued && nowMs >= this._nextRunAllowedAt;
    if (!scheduledDue && !queuedDue) return this.getStatus();
    if (nowMs < this._nextRunAllowedAt) return this.getStatus();

    await this._runRefresh(queuedDue ? (this._queuedReason || 'on_demand') : 'scheduled');
    return this.getStatus();
  }

  async _runRefresh(reason) {
    const startedAt = this._now();
    this._running = true;
    this._queued = false;
    this._runCount += 1;
    this._lastRunStartedAt = startedAt;
    this._lastRunReason = reason;
    this._lastError = null;
    this._lastExitCode = null;
    this._log('log', `\n🧪 LIVE 검증 리포트 갱신 시작 (${reason}) - fixed validation을 새로 실행합니다.`);

    let capturedInput;
    try {
      capturedInput = this._captureRuntimeValidationInput();
    } catch {
      this._running = false;
      this._lastError = 'runtime_validation_snapshot_unavailable';
      this._lastRunFinishedAt = this._now();
      this._nextRunAllowedAt = this._now() + this.minGapMs;
      this._log('error', '❌ 현재 투자 설정과 대상 코인을 확인할 수 없어 LIVE 검증 리포트를 갱신하지 않습니다.');
      return;
    }
    const { env, cleanup } = capturedInput;

    let child;
    try {
      child = this._spawn(this._processExecPath(), [this.scriptPath], {
        env,
        cwd: this._cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      cleanup();
      this._running = false;
      this._lastError = error.message;
      this._lastRunFinishedAt = this._now();
      this._nextRunAllowedAt = this._now() + this.minGapMs;
      this._log('error', `❌ validation 리포트 갱신 프로세스 생성 실패: ${error.message}`);
      return;
    }

    let outputTail = '';
    const append = chunk => {
      outputTail = (outputTail + chunk.toString()).slice(-2000);
    };
    child.stdout?.on?.('data', append);
    child.stderr?.on?.('data', append);

    let exitCode;
    try {
      exitCode = await new Promise(resolve => {
        const timer = this._setTimeout(() => {
          try { child.kill?.('SIGKILL'); } catch { /* ignore */ }
        }, this.timeoutMs);
        if (typeof timer?.unref === 'function') timer.unref();
        let settled = false;
        child.once('close', code => {
          if (settled) return;
          settled = true;
          this._clearTimeout(timer);
          resolve(code);
        });
        child.once('error', () => {
          if (settled) return;
          settled = true;
          this._clearTimeout(timer);
          resolve(-1);
        });
      });
    } finally {
      cleanup();
    }

    const finishedAt = this._now();
    this._running = false;
    this._lastRunFinishedAt = finishedAt;
    this._lastExitCode = exitCode;
    this._nextRunAllowedAt = finishedAt + this.minGapMs;
    this._lastReport = this._readReportSummary();

    if (exitCode === 0) {
      const promoted = this._lastReport?.promoted === true;
      this._log('log',
        `\n🧾 LIVE 검증 리포트 갱신 완료: 승격 ${promoted ? '가능' : '보류'} ` +
        `(${this._lastReport?.promotedMarkets ?? 0}/${this._lastReport?.markets ?? 0} 마켓)` +
        (promoted ? '' : ' - live 게이트는 새 리포트가 통과할 때까지 닫혀 있습니다.'));
    } else {
      this._lastError = `validation_exit_${exitCode}`;
      this._log('error',
        `❌ validation 리포트 갱신 실패 (exit=${exitCode}): ${outputTail.split('\n').filter(Boolean).slice(-3).join(' | ') || '출력 없음'}`);
    }
  }

  _captureRuntimeValidationInput() {
    if (typeof this.trader.getPaperValidationConfigSnapshot !== 'function') {
      throw new Error('Current runtime configuration is unavailable.');
    }
    const current = this.trader.getPaperValidationConfigSnapshot();
    const markets = this.trader.targetCoins;
    if (!current || typeof current !== 'object' || Array.isArray(current) ||
        !Array.isArray(markets) || markets.length === 0 ||
        markets.some(market => typeof market !== 'string' || !/^KRW-[A-Z0-9]{2,15}$/.test(market)) ||
        new Set(markets).size !== markets.length) {
      throw new Error('Current runtime configuration or resolved markets are invalid.');
    }
    const configSnapshot = Object.fromEntries(LIVE_GATE_COMPARABLE_KEYS.map(key => {
      const value = current[key];
      const valid = BOOLEAN_SNAPSHOT_KEYS.has(key)
        ? typeof value === 'boolean'
        : key === 'signalProfile'
          ? SIGNAL_PROFILES.has(value)
          : typeof value === 'number' && Number.isFinite(value);
      if (!valid) throw new Error('Current runtime configuration is incomplete.');
      return [key, value];
    }));
    const env = {
      ...this._env,
      SCALP_VALIDATION_FIXED: 'true',
      SCALP_VALIDATION_OUTPUT_FILE: this._reportPath(),
      SCALP_VALIDATION_MARKETS: markets.join(','),
      SCALP_VALIDATION_CANDLE_UNIT: String(configSnapshot.candleUnit)
    };
    delete env.SCALP_VALIDATION_CANDLES_FILE;
    for (const [key, envKey] of Object.entries(RUNTIME_BEHAVIOR_ENV)) {
      env[envKey] = String(configSnapshot[key]);
    }
    const directory = fs.mkdtempSync(path.join(this._snapshotTempRoot, 'coinpilot-live-validation-'));
    const snapshotFile = path.join(directory, 'runtime-config.json');
    const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
    try {
      const fd = fs.openSync(snapshotFile, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          sourceType: 'runtime_config_snapshot',
          capturedAt: new Date(this._now()).toISOString(),
          targetCoins: [...markets],
          configSnapshotComplete: true,
          configSnapshot
        }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Verify the child's reader can consume this exact file before spawn.
      loadPaperValidationConfigSnapshot(snapshotFile);
      env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE = snapshotFile;
      return { env, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  _processExecPath() {
    return this._execPath;
  }

  _log(level, message) {
    const logger = this._logger;
    const fn = level === 'error' ? logger.error : logger.log;
    if (typeof fn === 'function') fn.call(logger, message);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      eligible: this._eligible(),
      active: this._timer !== null,
      running: this._running,
      queued: this._queued,
      runCount: this._runCount,
      lastRunStartedAt: this._lastRunStartedAt === null ? null : new Date(this._lastRunStartedAt).toISOString(),
      lastRunFinishedAt: this._lastRunFinishedAt === null ? null : new Date(this._lastRunFinishedAt).toISOString(),
      lastRunReason: this._lastRunReason,
      lastExitCode: this._lastExitCode,
      lastError: this._lastError,
      lastReport: this._lastReport,
      reportFile: this.reportFile
    };
  }
}

export function createLiveValidationReportRefresher(trader, config = {}, options = {}) {
  return new LiveValidationReportRefresher(trader, {
    enabled: config.liveValidationRefreshEnabled !== false,
    intervalMs: config.liveValidationRefreshIntervalMs,
    minGapMs: config.liveValidationRefreshMinGapMs,
    timeoutMs: config.liveValidationRefreshTimeoutMs,
    reportFile: config.scalpingValidationOutputFile,
    ...options
  });
}
