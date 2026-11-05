// OperatorAlertMonitor — pushes the state changes an operator must not miss.
//
// It only reads the trader (isRunning, getRuntimeSafetyStatus, strategies) and
// queues phone alerts through OrderPushService. It never starts, stops, or
// trades. Alerts:
//   - automatic trading stopped (with the reason and held positions)
//   - trading resumed after a stop
//   - protective-only mode (LIVE positions guarded, no new entries)
//   - positions still held while trading is stopped (reminder, then every 6h)
//   - daily summary after 22:00 KST
import { isUnsellableDust } from '../trader/positionRebalancer.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const STOP_REASON_LABELS = {
  risk_data_gap: '보유 포지션 시세를 30초 넘게 받지 못해 안전 정지했습니다',
  analysis_data_gap: '시장 분석 데이터가 끊겨 안전 정지했습니다',
  exchange_state_unverified: '거래소 잔고·주문 상태를 확인하지 못해 멈췄습니다',
  operator_stop: '운영자가 정지했습니다',
  operator_shutdown: '서버 종료로 정지했습니다',
  loss_circuit_breaker: '연속 손실 한도에 걸려 정지했습니다'
};

/** Start of the KST calendar day containing `nowMs`, as a UTC epoch. */
export function startOfKstDay(nowMs) {
  return Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

export function kstDateKey(nowMs) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function describeStopReason(reason) {
  if (!reason) return '정지 사유가 기록되지 않았습니다';
  return STOP_REASON_LABELS[reason] || `정지 사유: ${reason}`;
}

function formatSignedKrw(value) {
  const rounded = Math.round(Number(value) || 0);
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString('ko-KR')}원`;
}

export class OperatorAlertMonitor {
  constructor({
    tradingSystem,
    push,
    now = () => Date.now(),
    intervalMs = 30000,
    heldWhileStoppedAfterMs = 30 * 60 * 1000,
    heldWhileStoppedRepeatMs = 6 * 60 * 60 * 1000,
    dailySummaryHourKst = 22,
    logger = console
  }) {
    this.tradingSystem = tradingSystem;
    this.push = push;
    this.now = now;
    this.intervalMs = intervalMs;
    this.heldWhileStoppedAfterMs = heldWhileStoppedAfterMs;
    this.heldWhileStoppedRepeatMs = heldWhileStoppedRepeatMs;
    this.dailySummaryHourKst = dailySummaryHourKst;
    this.logger = logger;
    this.previous = null;
    this.stoppedSince = null;
    this.lastHeldReminderAt = null;
    this.timer = null;
    this.inFlight = null;
    this.modeLabel = tradingSystem?.dryRun === false ? '실거래' : '모의투자';
  }

  start() {
    if (this.timer || !this.tradingSystem || !this.push) return;
    this.timer = setInterval(() => { this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  heldPositions() {
    const held = [];
    for (const [coin, strategy] of this.tradingSystem.strategies || []) {
      const position = strategy?.currentPosition;
      if (position && !isUnsellableDust(this.tradingSystem, position)) held.push({ coin, position });
    }
    return held;
  }

  readState() {
    const safety = this.tradingSystem.getRuntimeSafetyStatus?.() || {};
    const protective = safety.runtimeState === 'PROTECTIVE_ONLY';
    return {
      running: this.tradingSystem.isRunning === true,
      protective,
      stopReason: safety.stopReason ?? this.tradingSystem.stopReason ?? null,
      autoRecoveryWaiting: safety.autoRecovery?.armed === true
    };
  }

  alert(key, title, body, category = 'status') {
    try {
      this.push.enqueueAlert({ key, title: `${this.modeLabel} · ${title}`, body, category });
    } catch (error) {
      this.push.error = error.message;
      this.logger.error?.(`운영 알림 기록 실패: ${error.message}`);
    }
  }

  tick() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._tick()
      .catch(error => this.logger.error?.(`운영 알림 점검 실패: ${error.message}`))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _tick() {
    const nowMs = this.now();
    const state = this.readState();
    const held = this.heldPositions();
    const heldText = held.length > 0
      ? `보유 ${held.length}개(${held.slice(0, 5).map(item => item.coin.replace(/^KRW-/, '')).join(', ')})`
      : '보유 포지션 없음';
    const previous = this.previous;
    const minuteKey = Math.floor(nowMs / 60000);

    if (previous) {
      if (previous.running && !state.running && !state.protective) {
        const recovery = state.autoRecoveryWaiting ? ' 데이터가 회복되면 자동으로 다시 시작합니다.' : '';
        this.alert(`stop|${minuteKey}`, '자동매매 정지', `${describeStopReason(state.stopReason)}. ${heldText}.${recovery}`, 'safety');
      } else if (!previous.protective && state.protective) {
        this.alert(`protective|${minuteKey}`, '보호 모드',
          `${describeStopReason(state.stopReason)}. 신규 매수는 멈추고 ${heldText}의 손절·익절 감시는 계속합니다.`, 'safety');
      } else if (!previous.running && state.running) {
        const after = this.stoppedSince ? ` (${Math.max(1, Math.round((nowMs - this.stoppedSince) / 60000))}분 만에)` : '';
        this.alert(`resume|${minuteKey}`, '자동매매 재개', `자동매매가 다시 실행 중입니다${after}.`, 'status');
      }
    }

    if (state.running) {
      this.stoppedSince = null;
      this.lastHeldReminderAt = null;
    } else {
      this.stoppedSince ??= nowMs;
      // A stopped trader does not run stop-loss/take-profit/max-hold for paper,
      // and LIVE only does so in protective mode. Remind until it is resolved.
      if (held.length > 0 && !state.protective &&
        nowMs - this.stoppedSince >= this.heldWhileStoppedAfterMs &&
        (this.lastHeldReminderAt === null || nowMs - this.lastHeldReminderAt >= this.heldWhileStoppedRepeatMs)) {
        this.lastHeldReminderAt = nowMs;
        const minutes = Math.round((nowMs - this.stoppedSince) / 60000);
        this.alert(`held|${minuteKey}`, '멈춘 채 포지션 보유 중',
          `자동매매가 ${minutes}분째 멈춰 있어 손절·익절이 동작하지 않습니다. ${heldText}. ${describeStopReason(state.stopReason)}.`, 'safety');
      }
    }

    this.previous = state;
    await this.maybeDailySummary(nowMs);
  }

  async maybeDailySummary(nowMs) {
    const dayStart = startOfKstDay(nowMs);
    if (nowMs < dayStart + this.dailySummaryHourKst * 60 * 60 * 1000) return;
    const dateKey = kstDateKey(nowMs);
    if (this.lastSummaryDate === dateKey) return;
    this.lastSummaryDate = dateKey;

    let realized = 0;
    let closes = 0;
    let wins = 0;
    let buys = 0;
    for (const strategy of this.tradingSystem.strategies?.values?.() || []) {
      for (const trade of strategy.tradeHistory || []) {
        if (trade.action === 'OPEN' && Date.parse(trade.entryTime) >= dayStart) buys++;
        if (trade.action !== 'CLOSE' && trade.action !== 'PARTIAL_CLOSE') continue;
        const exitMs = Date.parse(trade.exitTime || trade.timestamp);
        if (!(exitMs >= dayStart)) continue;
        const profit = Number(trade.profit) || 0;
        realized += profit;
        closes++;
        if (profit > 0) wins++;
      }
    }
    let assetsText = '';
    try {
      const totalAssets = await this.tradingSystem.calculateTotalAssets?.();
      if (Number.isFinite(totalAssets)) assetsText = ` 총자산 ${Math.round(totalAssets).toLocaleString('ko-KR')}원.`;
    } catch {
      // The summary still goes out without the asset line.
    }
    const held = this.heldPositions().length;
    const body = closes === 0 && buys === 0
      ? `오늘은 체결이 없었습니다. 보유 ${held}개.${assetsText}`
      : `실현 손익 ${formatSignedKrw(realized)} · 매수 ${buys}건 · 매도 ${closes}건(이익 ${wins}건) · 보유 ${held}개.${assetsText}`;
    this.alert(`daily|${dateKey}`, `오늘 요약 (${dateKey.slice(5).replace('-', '/')})`, body, 'summary');
  }
}

export default OperatorAlertMonitor;
